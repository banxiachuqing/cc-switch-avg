//! 聚合供应商:把 Claude 的模型档位请求路由到不同来源供应商。
//!
//! 聚合供应商(`meta.provider_type == "aggregate"`)本身不持有上游凭证;
//! `settings_config.aggregate` 把每个模型档位绑定到一个普通供应商
//! (提供凭证/格式转换管线)和一个发给上游的模型名。

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model_mapper::{classify_model_tier, strip_one_m_suffix_for_upstream, ModelTier};

pub const AGGREGATE_PROVIDER_TYPE: &str = "aggregate";

/// 单档绑定:来源供应商 + 上游模型名
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AggregateBinding {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
}

/// 聚合供应商的档位绑定表(default 必填,其余选填)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AggregateBindings {
    #[serde(default)]
    pub default: Option<AggregateBinding>,
    #[serde(default)]
    pub opus: Option<AggregateBinding>,
    #[serde(default)]
    pub sonnet: Option<AggregateBinding>,
    #[serde(default)]
    pub haiku: Option<AggregateBinding>,
    #[serde(default)]
    pub fable: Option<AggregateBinding>,
    #[serde(default)]
    pub subagent: Option<AggregateBinding>,
}

impl AggregateBindings {
    /// 从供应商配置解析绑定表;没有 aggregate 键或解析失败返回 None
    pub fn from_provider(provider: &Provider) -> Option<Self> {
        provider
            .settings_config
            .get("aggregate")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// 档位回退链:fable → opus → default;其余具名档 → default
    fn binding_for(&self, tier: ModelTier) -> Option<&AggregateBinding> {
        match tier {
            ModelTier::Fable => self
                .fable
                .as_ref()
                .or(self.opus.as_ref())
                .or(self.default.as_ref()),
            ModelTier::Opus => self.opus.as_ref().or(self.default.as_ref()),
            ModelTier::Sonnet => self.sonnet.as_ref().or(self.default.as_ref()),
            ModelTier::Haiku => self.haiku.as_ref().or(self.default.as_ref()),
            ModelTier::Default => self.default.as_ref(),
        }
    }
}

pub fn is_aggregate_provider(provider: &Provider) -> bool {
    provider
        .meta
        .as_ref()
        .and_then(|m| m.provider_type.as_deref())
        == Some(AGGREGATE_PROVIDER_TYPE)
}

/// 聚合路由结果:改投的来源供应商 + 已改写模型名的请求体
pub struct AggregateRoute {
    pub provider: Provider,
    pub body: Value,
}

/// 加载绑定来源供应商;不存在或嵌套聚合供应商都视为悬空
fn load_source(
    db: &Database,
    app_type: &str,
    binding: &AggregateBinding,
) -> Result<Option<Provider>, AppError> {
    match db.get_provider_by_id(&binding.provider_id, app_type)? {
        Some(p) if !is_aggregate_provider(&p) => Ok(Some(p)),
        _ => Ok(None),
    }
}

/// 为单个请求解析聚合路由。current 不是聚合供应商时返回 Ok(None)。
///
/// 悬空引用语义:非 default 档落 default 档;default 档悬空(或未配置)报错。
pub fn resolve_route(
    db: &Database,
    current: &Provider,
    body: &Value,
) -> Result<Option<AggregateRoute>, AppError> {
    if !is_aggregate_provider(current) {
        return Ok(None);
    }
    let bindings = AggregateBindings::from_provider(current).ok_or_else(|| {
        AppError::Config(format!(
            "聚合供应商 {} 的 aggregate 配置无法解析",
            current.id
        ))
    })?;

    let model = body.get("model").and_then(Value::as_str).unwrap_or("");

    // subagent 档:与 live 中配置的 CLAUDE_CODE_SUBAGENT_MODEL 精确匹配
    // (剥离 [1M] 标记后比较),先于关键字分类。
    let subagent_name = current
        .settings_config
        .get("env")
        .and_then(|e| e.get("CLAUDE_CODE_SUBAGENT_MODEL"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let is_subagent = subagent_name
        .map(|s| strip_one_m_suffix_for_upstream(model) == strip_one_m_suffix_for_upstream(s))
        .unwrap_or(false);

    // default 档是整个绑定表的兜底:未配置或悬空(已删除/嵌套聚合)都直接报错
    let default_binding = bindings.default.as_ref().ok_or_else(|| {
        AppError::localized(
            "aggregate.default_required",
            format!("聚合供应商 {} 缺少 default 档绑定", current.name),
            format!(
                "Aggregate provider {} has no default tier binding",
                current.name
            ),
        )
    })?;
    let default_source = load_source(db, "claude", default_binding)?.ok_or_else(|| {
        AppError::localized(
            "aggregate.default_dangling",
            format!(
                "聚合供应商 {} 的 default 档来源供应商已被删除,请编辑后重试",
                current.name
            ),
            format!(
                "Default tier of aggregate provider {} points to a deleted provider",
                current.name
            ),
        )
    })?;

    let binding = if is_subagent {
        bindings.subagent.as_ref().or(bindings.default.as_ref())
    } else {
        bindings.binding_for(classify_model_tier(model))
    };
    // default 已在上方校验存在,这里只为 Option 类型兜底
    let binding = binding.unwrap_or(default_binding);

    // 来源供应商悬空:非 default 档回退 default 档
    let (source, binding) = match load_source(db, "claude", binding)? {
        Some(p) => (p, binding.clone()),
        None => (default_source, default_binding.clone()),
    };

    let mut new_body = body.clone();
    new_body["model"] = Value::String(binding.model.clone());
    log::debug!(
        "[Aggregate] {} 档路由: {} → 供应商 {} 模型 {}",
        model,
        current.id,
        source.id,
        binding.model
    );
    Ok(Some(AggregateRoute {
        provider: source,
        body: new_body,
    }))
}

/// 代理入口的聚合改路由:仅 Claude 且当前供应商为聚合类型时生效。
/// 显式检查当前供应商(而非 select_providers 的结果),因此故障转移
/// 队列对聚合供应商不生效——绑定表即路由。
pub fn override_route_for_aggregate(
    db: &Database,
    app_type: &AppType,
    body: &Value,
) -> Result<Option<AggregateRoute>, AppError> {
    if !matches!(app_type, AppType::Claude) {
        return Ok(None);
    }
    let current_id = crate::settings::get_effective_current_provider(db, app_type)
        .ok()
        .flatten()
        .or_else(|| db.get_current_provider(app_type.as_str()).ok().flatten());
    let Some(current) = current_id
        .and_then(|id| db.get_provider_by_id(&id, app_type.as_str()).ok().flatten())
        .filter(is_aggregate_provider)
    else {
        return Ok(None);
    };
    resolve_route(db, &current, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::provider::{Provider, ProviderMeta};
    use serde_json::json;
    use serial_test::serial;
    use std::env;
    use std::sync::Arc;
    use tempfile::TempDir;

    // 与 provider_router.rs 测试模块相同的 TempHome 写法
    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();
            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            crate::settings::reload_settings().expect("reload settings");
            Self {
                dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => env::set_var("HOME", value),
                None => env::remove_var("HOME"),
            }
            match &self.original_userprofile {
                Some(value) => env::set_var("USERPROFILE", value),
                None => env::remove_var("USERPROFILE"),
            }
            match &self.original_test_home {
                Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
                None => env::remove_var("CC_SWITCH_TEST_HOME"),
            }
            crate::settings::reload_settings().expect("restore settings");
        }
    }

    fn source_provider(id: &str) -> Provider {
        Provider::with_id(
            id.to_string(),
            format!("Source {id}"),
            json!({"env": {}}),
            None,
        )
    }

    fn aggregate_provider_with_id(id: &str, bindings: Value) -> Provider {
        let mut p = Provider::with_id(
            id.to_string(),
            format!("聚合-{id}"),
            json!({ "env": {}, "aggregate": bindings }),
            None,
        );
        p.meta = Some(ProviderMeta {
            provider_type: Some(AGGREGATE_PROVIDER_TYPE.to_string()),
            ..Default::default()
        });
        p
    }

    fn aggregate_provider(bindings: Value) -> Provider {
        aggregate_provider_with_id("agg", bindings)
    }

    fn setup_db(current: &Provider, sources: &[Provider]) -> Arc<Database> {
        let db = Arc::new(Database::memory().unwrap());
        for p in sources {
            db.save_provider("claude", p).unwrap();
        }
        db.save_provider("claude", current).unwrap();
        db.set_current_provider("claude", &current.id).unwrap();
        db
    }

    #[test]
    #[serial]
    fn non_aggregate_current_returns_none() {
        let _home = TempHome::new();
        let plain = source_provider("a");
        let db = setup_db(&plain, &[]);
        let body = json!({"model": "claude-opus-4-5"});
        assert!(resolve_route(&db, &plain, &body).unwrap().is_none());
    }

    #[test]
    #[serial]
    fn opus_tier_routes_to_bound_provider_and_rewrites_model() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "b", "model": "b-opus-x"}
        }));
        let db = setup_db(&agg, &[source_provider("a"), source_provider("b")]);
        let body = json!({"model": "claude-opus-4-5"});
        let route = resolve_route(&db, &agg, &body).unwrap().unwrap();
        assert_eq!(route.provider.id, "b");
        assert_eq!(route.body["model"], "b-opus-x");
    }

    #[test]
    #[serial]
    fn fable_falls_back_to_opus_then_default() {
        let _home = TempHome::new();
        // 只配 opus:fable 请求落 opus 档
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "b", "model": "b-opus-x"}
        }));
        let db = setup_db(&agg, &[source_provider("a"), source_provider("b")]);
        let route = resolve_route(&db, &agg, &json!({"model": "claude-fable-5"}))
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.id, "b");

        // opus 也没配:落 default
        let agg2 = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"}
        }));
        let route2 = resolve_route(&db, &agg2, &json!({"model": "claude-fable-5[1M]"}))
            .unwrap()
            .unwrap();
        assert_eq!(route2.provider.id, "a");
        assert_eq!(route2.body["model"], "a-default");
    }

    #[test]
    #[serial]
    fn unknown_model_uses_default_tier() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "sonnet": {"providerId": "c", "model": "c-sonnet"}
        }));
        let db = setup_db(&agg, &[source_provider("a"), source_provider("c")]);
        let route = resolve_route(&db, &agg, &json!({"model": "some-future-model"}))
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.id, "a");
    }

    #[test]
    #[serial]
    fn subagent_matches_env_name_exactly() {
        let _home = TempHome::new();
        let mut agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "subagent": {"providerId": "b", "model": "b-sub"}
        }));
        agg.settings_config["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] = json!("cc-switch-subagent");
        let db = setup_db(&agg, &[source_provider("a"), source_provider("b")]);

        let route = resolve_route(&db, &agg, &json!({"model": "cc-switch-subagent"}))
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.id, "b");
        assert_eq!(route.body["model"], "b-sub");

        // 精确匹配之外的请求不受影响
        let route2 = resolve_route(&db, &agg, &json!({"model": "claude-haiku-4-5"}))
            .unwrap()
            .unwrap();
        assert_eq!(route2.provider.id, "a");
    }

    #[test]
    #[serial]
    fn dangling_non_default_binding_falls_back_to_default() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "deleted", "model": "gone"}
        }));
        let db = setup_db(&agg, &[source_provider("a")]);
        let route = resolve_route(&db, &agg, &json!({"model": "claude-opus-4-5"}))
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.id, "a");
        assert_eq!(route.body["model"], "a-default");
    }

    #[test]
    #[serial]
    fn dangling_default_binding_is_error() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "deleted", "model": "gone"},
            "opus": {"providerId": "a", "model": "a-opus"}
        }));
        let db = setup_db(&agg, &[source_provider("a")]);
        assert!(resolve_route(&db, &agg, &json!({"model": "claude-opus-4-5"})).is_err());
    }

    #[test]
    #[serial]
    fn missing_default_binding_is_error() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "opus": {"providerId": "a", "model": "a-opus"}
        }));
        let db = setup_db(&agg, &[source_provider("a")]);
        assert!(resolve_route(&db, &agg, &json!({"model": "claude-opus-4-5"})).is_err());
    }

    #[test]
    #[serial]
    fn aggregate_source_is_treated_as_dangling() {
        let _home = TempHome::new();
        // 嵌套引用聚合供应商 = 非法,落 default
        let nested = aggregate_provider_with_id(
            "nested",
            json!({
                "default": {"providerId": "a", "model": "a-default"}
            }),
        );
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "nested", "model": "x"}
        }));
        let db = Arc::new(Database::memory().unwrap());
        db.save_provider("claude", &nested).unwrap();
        db.save_provider("claude", &source_provider("a")).unwrap();
        db.save_provider("claude", &agg).unwrap();
        db.set_current_provider("claude", "agg").unwrap();
        let route = resolve_route(&db, &agg, &json!({"model": "claude-opus-4-5"}))
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.id, "a");
    }

    #[test]
    #[serial]
    fn override_returns_none_for_normal_current_provider() {
        let _home = TempHome::new();
        let plain = source_provider("a");
        let db = setup_db(&plain, &[]);
        assert!(override_route_for_aggregate(
            &db,
            &AppType::Claude,
            &json!({"model": "claude-opus-4-5"})
        )
        .unwrap()
        .is_none());
    }

    #[test]
    #[serial]
    fn override_ignores_failover_queue_when_current_is_aggregate() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "b", "model": "b-opus-x"}
        }));
        let db = setup_db(&agg, &[source_provider("a"), source_provider("b")]);
        // 开启故障转移并把别的供应商塞入队列:聚合路由仍应胜出
        let mut config =
            futures::executor::block_on(db.get_proxy_config_for_app("claude")).unwrap();
        config.auto_failover_enabled = true;
        futures::executor::block_on(db.update_proxy_config_for_app(config)).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        let route = override_route_for_aggregate(
            &db,
            &AppType::Claude,
            &json!({"model": "claude-opus-4-5"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(route.provider.id, "b");

        // 非 Claude 应用直接 None
        assert!(
            override_route_for_aggregate(&db, &AppType::Codex, &json!({"model": "m"}))
                .unwrap()
                .is_none()
        );
    }
}
