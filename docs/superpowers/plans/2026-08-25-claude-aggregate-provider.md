# Claude 聚合供应商实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「聚合供应商」虚拟类型（仅 Claude),5+1 模型档各自绑定不同来源供应商与模型，由本地代理按档路由。

**Architecture:** 绑定存于聚合供应商的 `settings_config.aggregate`（零 DB 迁移）；代理 `handle_messages_for_app` 在转发前做档分类 → 绑定解析 → 替换候选供应商并改写模型名；来源供应商走完整现有转发管线（格式转换/熔断/用量归因）。

**Tech Stack:** Rust 1.95 + Tauri 2.8(rusqlite/axum)、React 18 + TS + react-hook-form + TanStack Query v5、vitest、cargo test。

**设计文档:** `docs/superpowers/specs/2026-08-25-claude-aggregate-provider-design.md`（已批准）

## Global Constraints

- 仅影响 Claude 应用；其他 8 个 AppType 行为不变。
- 零 DB schema 迁移：绑定存 `Provider.settings_config` 的 `aggregate` 键。
- **禁止修改 `model_mapper.rs` 中 `map_model` 的现有行为**（新增函数，不重构）。
- 官方供应商（`category == "official"`）不可作为聚合来源（防代理访问官方 API 的封号风险）。
- 用户可见错误消息用 `AppError::localized(key, zh, en)`；新增 UI 文案同步 zh / zh-TW / en / ja 四个 locale 文件（`localeCoverage` 测试会校验）。
- Rust 测试模式：内存 DB `Database::memory()`（`src-tauri/src/database/mod.rs:186`)+ 每个测试文件自带的 `TempHome`（复制 `src-tauri/src/proxy/provider_router.rs:324-370` 的写法）+ `serial_test::serial`。
- 提交：conventional commits，无 attribution；Rust 提交前 `cargo fmt`，前端提交前 `pnpm exec prettier --write <改动文件>`。
- 构建/测试优先走 IDEA MCP（`execute_terminal_command`)，环境不可用时退回终端。
- 当前分支：`feat/claude-aggregate-provider`。

---

### Task 1: 模型档分类函数 `classify_model_tier`

**Files:**
- Modify: `src-tauri/src/proxy/model_mapper.rs`（在 `strip_one_m_suffix_for_upstream` 之后追加新函数；`map_model` 一行不动）

**Interfaces:**
- Produces: `pub enum ModelTier { Fable, Haiku, Opus, Sonnet, Default }` 和 `pub fn classify_model_tier(model: &str) -> ModelTier`。Task 2 的聚合路由依赖这两个符号。

- [ ] **Step 1: 写失败测试**

在 `model_mapper.rs` 的 `#[cfg(test)] mod tests` 中追加：

```rust
    #[test]
    fn classify_tier_by_keyword() {
        assert_eq!(classify_model_tier("claude-fable-5"), ModelTier::Fable);
        assert_eq!(classify_model_tier("claude-fable-5[1m]"), ModelTier::Fable);
        assert_eq!(classify_model_tier("claude-haiku-4-5"), ModelTier::Haiku);
        assert_eq!(classify_model_tier("claude-opus-4-5"), ModelTier::Opus);
        assert_eq!(classify_model_tier("Claude-SONNET-4-5"), ModelTier::Sonnet);
        assert_eq!(classify_model_tier("deepseek-v4-pro"), ModelTier::Default);
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib proxy::model_mapper::tests::classify_tier_by_keyword`
Expected: FAIL(`classify_model_tier` 未定义，编译错误）

- [ ] **Step 3: 实现**

在 `model_mapper.rs` 中（`ModelMapping` 实现之后）追加：

```rust
/// Claude Code 模型档位（按关键字分类）。
///
/// 判定顺序与 `map_model` 的关键字链一致：fable 最先（fable 档未配置时
/// 归入 opus 档的回退语义由调用方实现，这里只做分类）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelTier {
    Fable,
    Haiku,
    Opus,
    Sonnet,
    Default,
}

/// 按关键字把请求模型名分类到档位；大小写不敏感。
pub fn classify_model_tier(model: &str) -> ModelTier {
    let model_lower = model.to_lowercase();
    if model_lower.contains("fable") {
        ModelTier::Fable
    } else if model_lower.contains("haiku") {
        ModelTier::Haiku
    } else if model_lower.contains("opus") {
        ModelTier::Opus
    } else if model_lower.contains("sonnet") {
        ModelTier::Sonnet
    } else {
        ModelTier::Default
    }
}
```

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `cd src-tauri && cargo test --lib proxy::model_mapper`
Expected: PASS（新测试 + 全部既有 map_model 测试）

- [ ] **Step 5: 提交**

```bash
cd src-tauri && cargo fmt && cd ..
git add src-tauri/src/proxy/model_mapper.rs
git commit -m "feat(proxy): add classify_model_tier for aggregate routing"
```

---

### Task 2: 聚合绑定解析与路由解析模块 `proxy/aggregate.rs`

**Files:**
- Create: `src-tauri/src/proxy/aggregate.rs`
- Modify: `src-tauri/src/proxy/mod.rs`（注册 `pub mod aggregate;`，与既有 `mod model_mapper;` 等声明并列）

**Interfaces:**
- Consumes: Task 1 的 `classify_model_tier` / `ModelTier`;`Database::get_provider_by_id(id, app_type) -> Result<Option<Provider>>`、`get_all_providers(app_type)`、`get_current_provider(app_type)`;`crate::settings::get_effective_current_provider(&db, &AppType)`。
- Produces（后续任务依赖的精确签名）:
  - `pub const AGGREGATE_PROVIDER_TYPE: &str = "aggregate"`
  - `pub struct AggregateBinding { pub provider_id: String, pub model: String }`(serde `providerId`)
  - `pub struct AggregateBindings { default/opus/sonnet/haiku/fable/subagent: Option<AggregateBinding> }` + `AggregateBindings::from_provider(&Provider) -> Option<Self>`
  - `pub fn is_aggregate_provider(provider: &Provider) -> bool`
  - `pub struct AggregateRoute { pub provider: Provider, pub body: Value }`
  - `pub fn resolve_route(db: &Database, current: &Provider, body: &Value) -> Result<Option<AggregateRoute>, AppError>`
  - `pub fn override_route_for_aggregate(db: &Database, app_type: &AppType, body: &Value) -> Result<Option<AggregateRoute>, AppError>`

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/proxy/aggregate.rs`，先只放测试骨架（实现随后）。测试模块（`TempHome` 复制 `provider_router.rs:324-370` 的写法）:

```rust
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
            Self { dir, original_home, original_userprofile, original_test_home }
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
        Provider::with_id(id.to_string(), format!("Source {id}"), json!({"env": {}}), None)
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
        let route = resolve_route(&db, &agg, &json!({"model": "claude-fable-5"})).unwrap().unwrap();
        assert_eq!(route.provider.id, "b");

        // opus 也没配:落 default
        let agg2 = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"}
        }));
        let route2 = resolve_route(&db, &agg2, &json!({"model": "claude-fable-5[1M]"})).unwrap().unwrap();
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
        let route = resolve_route(&db, &agg, &json!({"model": "some-future-model"})).unwrap().unwrap();
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

        let route = resolve_route(&db, &agg, &json!({"model": "cc-switch-subagent"})).unwrap().unwrap();
        assert_eq!(route.provider.id, "b");
        assert_eq!(route.body["model"], "b-sub");

        // 精确匹配之外的请求不受影响
        let route2 = resolve_route(&db, &agg, &json!({"model": "claude-haiku-4-5"})).unwrap().unwrap();
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
        let route = resolve_route(&db, &agg, &json!({"model": "claude-opus-4-5"})).unwrap().unwrap();
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
        let nested = aggregate_provider_with_id("nested", json!({
            "default": {"providerId": "a", "model": "a-default"}
        }));
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "nested", "model": "x"}
        }));
        let db = Arc::new(Database::memory().unwrap());
        db.save_provider("claude", &nested).unwrap();
        db.save_provider("claude", &source_provider("a")).unwrap();
        db.save_provider("claude", &agg).unwrap();
        db.set_current_provider("claude", "agg").unwrap();
        let route = resolve_route(&db, &agg, &json!({"model": "claude-opus-4-5"})).unwrap().unwrap();
        assert_eq!(route.provider.id, "a");
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
        let mut config = futures::executor::block_on(db.get_proxy_config_for_app("claude")).unwrap();
        config.auto_failover_enabled = true;
        futures::executor::block_on(db.update_proxy_config_for_app(config)).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        let route = override_route_for_aggregate(&db, &AppType::Claude, &json!({"model": "claude-opus-4-5"}))
            .unwrap()
            .unwrap();
        assert_eq!(route.provider.id, "b");

        // 非 Claude 应用直接 None
        assert!(override_route_for_aggregate(&db, &AppType::Codex, &json!({"model": "m"}))
            .unwrap()
            .is_none());
    }
}
```

注意：测试里 `AppType` 需要 `use crate::app_config::AppType;`。

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib proxy::aggregate`
Expected: FAIL（模块/函数未定义，编译错误）

- [ ] **Step 3: 实现**

`aggregate.rs` 实现部分（放在测试模块之前）:

```rust
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
        AppError::Config(format!("聚合供应商 {} 的 aggregate 配置无法解析", current.id))
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
        .map(|s| {
            strip_one_m_suffix_for_upstream(model) == strip_one_m_suffix_for_upstream(s)
        })
        .unwrap_or(false);

    let binding = if is_subagent {
        bindings.subagent.as_ref().or(bindings.default.as_ref())
    } else {
        bindings.binding_for(classify_model_tier(model))
    };

    let binding = binding.ok_or_else(|| {
        AppError::localized(
            "aggregate.default_required",
            format!("聚合供应商 {} 缺少 default 档绑定", current.name),
            format!("Aggregate provider {} has no default tier binding", current.name),
        )
    })?;

    // 来源供应商悬空:非 default 档回退 default 档;default 档悬空则报错
    let (source, binding) = match load_source(db, "claude", binding)? {
        Some(p) => (p, binding.clone()),
        None => {
            let default_binding = bindings.default.as_ref().ok_or_else(|| {
                AppError::localized(
                    "aggregate.default_required",
                    format!("聚合供应商 {} 缺少 default 档绑定", current.name),
                    format!("Aggregate provider {} has no default tier binding", current.name),
                )
            })?;
            if default_binding.provider_id == binding.provider_id {
                return Err(AppError::localized(
                    "aggregate.default_dangling",
                    format!(
                        "聚合供应商 {} 的 default 档来源供应商已被删除,请编辑后重试",
                        current.name
                    ),
                    format!(
                        "Default tier of aggregate provider {} points to a deleted provider",
                        current.name
                    ),
                ));
            }
            let p = load_source(db, "claude", default_binding)?.ok_or_else(|| {
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
            (p, default_binding.clone())
        }
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
```

并在 `src-tauri/src/proxy/mod.rs` 注册（与既有模块声明并列）:

```rust
pub mod aggregate;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test --lib proxy::aggregate`
Expected: PASS(9 个测试）

- [ ] **Step 5: 提交**

```bash
cd src-tauri && cargo fmt && cd ..
git add src-tauri/src/proxy/aggregate.rs src-tauri/src/proxy/mod.rs
git commit -m "feat(proxy): add aggregate provider binding resolution and routing"
```

---

### Task 3: 代理请求接入聚合路由(`pre_mapped` 直通）

**Files:**
- Modify: `src-tauri/src/proxy/forwarder.rs`(`forward_with_retry` @370、`forward_with_retry_inner` @410、`forward` @1144)
- Modify: `src-tauri/src/proxy/handlers.rs`(`handle_messages_for_app` @165)
- Modify: `src-tauri/src/proxy/handlers.rs` 其余 `forward_with_retry` 调用点（@790、@885、@1001、@1084；以 `grep -n "forward_with_retry" src-tauri/src/proxy/handlers.rs` 为准）

**Interfaces:**
- Consumes: Task 2 的 `override_route_for_aggregate` / `AggregateRoute`。
- Produces: `forward_with_retry(..., providers: Vec<Provider>, pre_mapped: bool)`——`pre_mapped = true` 时 `forward()` 跳过 `apply_model_mapping`（绑定模型名是显式的，不能被来源供应商自身的 `ANTHROPIC_MODEL` 等映射覆盖）。

- [ ] **Step 1: 写失败测试**

在 `aggregate.rs` 测试模块追加（handler 胶水逻辑很薄，行为测试落在路由决策层）:

```rust
    #[test]
    #[serial]
    fn override_returns_none_for_normal_current_provider() {
        let _home = TempHome::new();
        let plain = source_provider("a");
        let db = setup_db(&plain, &[]);
        assert!(override_route_for_aggregate(&db, &AppType::Claude, &json!({"model": "claude-opus-4-5"}))
            .unwrap()
            .is_none());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib proxy::aggregate::tests::override_returns_none`
Expected: 此时应已 PASS(Task 2 已实现该函数）——本步改为验证 Task 2 全量测试仍绿：`cargo test --lib proxy::aggregate`

（说明：本任务的编译期回归由 Step 3 的签名修改驱动——所有调用点必须显式传 `pre_mapped`,编译器会抓出遗漏。)

- [ ] **Step 3: 实现**

`forwarder.rs` 三处签名加 `pre_mapped: bool` 并透传；`forward()` 的映射分支改为：

```rust
        let mapped_body = if pre_mapped {
            // 聚合路由已在 handler 层完成模型改写;绑定模型名是显式的,
            // 必须绕过来源供应商自身的档位映射,否则会被其
            // ANTHROPIC_MODEL 等 env 映射覆盖。[1M] 剥离等通用处理
            // 在后续步骤照常执行。
            body.clone()
        } else if matches!(app_type, AppType::ClaudeDesktop) {
            crate::claude_desktop_config::map_proxy_request_model(body.clone(), provider)
                .map_err(|e| ProxyError::InvalidRequest(e.to_string()))?
        } else {
            let (mapped_body, _original_model, _mapped_model) =
                super::model_mapper::apply_model_mapping(body.clone(), provider);
            mapped_body
        };
```

`handlers.rs` 的 `handle_messages_for_app` 中，在 `let is_stream = ...` 之后、`ctx.create_forwarder(&state)` 之前插入：

```rust
    // 聚合供应商:按模型档位把请求改路由到绑定的来源供应商。
    // 检查的是「当前供应商」而非故障转移队列结果,因此队列对聚合供应商不生效。
    let mut body = body;
    let mut providers = ctx.get_providers();
    let mut pre_mapped = false;
    if let Some(route) = crate::proxy::aggregate::override_route_for_aggregate(
        &state.db,
        &app_type,
        &body,
    )
    .map_err(|e| ProxyError::ConfigError(e.to_string()))?
    {
        body = route.body;
        providers = vec![route.provider];
        pre_mapped = true;
    }
```

然后把该函数内 `forward_with_retry(...)` 调用的 `ctx.get_providers()` 改为 `providers`，末尾追加 `pre_mapped` 实参。其余调用点（chat_completions / responses / alpha_search 等）全部追加 `false`。

- [ ] **Step 4: 编译 + 全量后端测试**

Run: `cd src-tauri && cargo test --features test-hooks`
Expected: PASS（编译器保证所有调用点已更新；无行为回归）

- [ ] **Step 5: 提交**

```bash
cd src-tauri && cargo fmt && cd ..
git add src-tauri/src/proxy/forwarder.rs src-tauri/src/proxy/handlers.rs src-tauri/src/proxy/aggregate.rs
git commit -m "feat(proxy): route Claude aggregate provider requests per model tier"
```

---

### Task 4: 保存校验与 backfill 跳过

**Files:**
- Modify: `src-tauri/src/proxy/aggregate.rs`（新增 `validate_bindings`)
- Modify: `src-tauri/src/services/provider/mod.rs`(`ProviderService::add` / `update` 入口校验；update 的 live 回填分支跳过聚合供应商）

**Interfaces:**
- Produces: `pub fn validate_bindings(db: &Database, app_type: &str, self_id: &str, provider: &Provider) -> Result<(), AppError>` —— default 档必填、模型名非空、来源供应商存在、禁止自引用、禁止嵌套聚合、禁止官方供应商来源。

- [ ] **Step 1: 写失败测试**

在 `aggregate.rs` 测试模块追加：

```rust
    #[test]
    #[serial]
    fn validate_requires_default_tier() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "opus": {"providerId": "a", "model": "a-opus"}
        }));
        let db = setup_db(&agg, &[source_provider("a")]);
        let err = validate_bindings(&db, "claude", "agg", &agg).unwrap_err();
        assert!(err.to_string().contains("default"));
    }

    #[test]
    #[serial]
    fn validate_rejects_missing_or_aggregate_or_official_or_self_source() {
        let _home = TempHome::new();
        let mut official = source_provider("off");
        official.category = Some("official".to_string());
        let db = Arc::new(Database::memory().unwrap());
        db.save_provider("claude", &source_provider("a")).unwrap();
        db.save_provider("claude", &official).unwrap();

        // 引用不存在的供应商
        let bad = aggregate_provider(json!({
            "default": {"providerId": "ghost", "model": "x"}
        }));
        assert!(validate_bindings(&db, "claude", "agg", &bad).is_err());

        // 引用聚合供应商(嵌套)
        let nested_agg = aggregate_provider_with_id("agg-nested-check", json!({
            "default": {"providerId": "a", "model": "a-default"}
        }));
        db.save_provider("claude", &nested_agg).unwrap();
        let bad = aggregate_provider(json!({
            "default": {"providerId": "agg-nested-check", "model": "x"}
        }));
        assert!(validate_bindings(&db, "claude", "agg", &bad).is_err());

        // 引用官方供应商
        let bad = aggregate_provider(json!({
            "default": {"providerId": "off", "model": "x"}
        }));
        assert!(validate_bindings(&db, "claude", "agg", &bad).is_err());

        // 自引用
        let bad = aggregate_provider(json!({
            "default": {"providerId": "agg", "model": "x"}
        }));
        assert!(validate_bindings(&db, "claude", "agg", &bad).is_err());

        // 空模型名
        let bad = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "  "}
        }));
        assert!(validate_bindings(&db, "claude", "agg", &bad).is_err());

        // 合法配置通过
        let good = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "a", "model": "a-opus"}
        }));
        assert!(validate_bindings(&db, "claude", "agg", &good).is_ok());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib proxy::aggregate::tests::validate`
Expected: FAIL(`validate_bindings` 未定义）

- [ ] **Step 3: 实现**

`aggregate.rs` 追加：

```rust
/// 保存聚合供应商前的校验:default 档必填、来源供应商合法。
/// self_id 为正在保存的供应商自身 id(新增时传将要使用的 id)。
pub fn validate_bindings(
    db: &Database,
    app_type: &str,
    self_id: &str,
    provider: &Provider,
) -> Result<(), AppError> {
    let bindings = AggregateBindings::from_provider(provider).ok_or_else(|| {
        AppError::localized(
            "aggregate.config_invalid",
            "聚合供应商缺少有效的档位绑定配置",
            "Aggregate provider is missing valid tier bindings",
        )
    })?;

    let check = |binding: &AggregateBinding, tier: &str| -> Result<(), AppError> {
        if binding.model.trim().is_empty() {
            return Err(AppError::localized(
                "aggregate.model_empty",
                format!("聚合供应商 {tier} 档的上游模型名不能为空"),
                format!("Aggregate tier {tier} requires an upstream model name"),
            ));
        }
        if binding.provider_id == self_id {
            return Err(AppError::localized(
                "aggregate.self_reference",
                format!("聚合供应商 {tier} 档不能引用自身"),
                format!("Aggregate tier {tier} cannot reference the aggregate provider itself"),
            ));
        }
        match db.get_provider_by_id(&binding.provider_id, app_type)? {
            None => Err(AppError::localized(
                "aggregate.source_missing",
                format!("聚合供应商 {tier} 档引用的来源供应商不存在"),
                format!("Aggregate tier {tier} references a provider that does not exist"),
            )),
            Some(p) if is_aggregate_provider(&p) => Err(AppError::localized(
                "aggregate.nested",
                format!("聚合供应商 {tier} 档不能引用另一个聚合供应商"),
                format!("Aggregate tier {tier} cannot reference another aggregate provider"),
            )),
            Some(p) if p.category.as_deref() == Some("official") => Err(AppError::localized(
                "aggregate.official_source",
                format!("聚合供应商 {tier} 档不能引用官方供应商(代理访问官方 API 有封号风险)"),
                format!("Aggregate tier {tier} cannot reference an official provider"),
            )),
            Some(_) => Ok(()),
        }
    };

    let default = bindings.default.as_ref().ok_or_else(|| {
        AppError::localized(
            "aggregate.default_required",
            "聚合供应商必须配置 default 档作为兜底",
            "Aggregate provider requires a default tier binding",
        )
    })?;
    check(default, "default")?;
    for (tier, binding) in [
        ("opus", &bindings.opus),
        ("sonnet", &bindings.sonnet),
        ("haiku", &bindings.haiku),
        ("fable", &bindings.fable),
        ("subagent", &bindings.subagent),
    ] {
        if let Some(b) = binding {
            check(b, tier)?;
        }
    }
    Ok(())
}
```

然后在 `src-tauri/src/services/provider/mod.rs` 的 `ProviderService::add` 与 `ProviderService::update` 中，写库之前插入（先用 codegraph 定位两函数体内首个 DB 写调用，插在其前）:

```rust
        if matches!(app_type, AppType::Claude)
            && crate::proxy::aggregate::is_aggregate_provider(&provider)
        {
            crate::proxy::aggregate::validate_bindings(
                &state.db,
                app_type.as_str(),
                &provider.id,
                &provider,
            )?;
        }
```

再在 `update` 的「编辑当前供应商时从 live 回填」分支条件中追加 `&& !crate::proxy::aggregate::is_aggregate_provider(&provider)`（聚合供应商不参与 backfill，以表单为准；用 codegraph 查 `backfill` 定位该分支）。

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test --lib proxy::aggregate && cargo test --test provider_service`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd src-tauri && cargo fmt && cd ..
git add src-tauri/src/proxy/aggregate.rs src-tauri/src/services/provider/mod.rs
git commit -m "feat(provider): validate aggregate bindings on save, skip backfill"
```

---

### Task 5: 删除供应商的引用完整性

**Files:**
- Modify: `src-tauri/src/proxy/aggregate.rs`（新增 `AggregateReference` / `find_aggregate_references` / `remove_bindings_to`)
- Modify: `src-tauri/src/services/provider/mod.rs`(`delete` @4800 改为委托新的 `delete_with_cascade`)
- Modify: `src-tauri/src/commands/provider.rs`(`delete_provider` 加 `cascade: Option<bool>` 参数；新增 `get_aggregate_references` 命令）
- Modify: `src-tauri/src/lib.rs`（在 `generate_handler!` 中 `delete_provider` 旁注册 `commands::provider::get_aggregate_references`)

**Interfaces:**
- Produces:
  - `pub struct AggregateReference { pub aggregate_provider_id: String, pub aggregate_provider_name: String, pub tiers: Vec<String>, pub includes_default: bool }`(serde `rename_all = "camelCase"`)
  - `pub fn find_aggregate_references(db: &Database, app_type: &str, provider_id: &str) -> Result<Vec<AggregateReference>, AppError>`
  - `pub fn remove_bindings_to(db: &Database, app_type: &str, provider_id: &str) -> Result<usize, AppError>`（只清非 default 档）
  - `ProviderService::delete_with_cascade(state, app_type, id, cascade: bool)`;`delete` 保持签名不变，委托 `cascade = false`
  - Tauri 命令：`get_aggregate_references(app: String, providerId: String) -> Vec<AggregateReference>`;`delete_provider` 新增可选 `cascade`

- [ ] **Step 1: 写失败测试**

`aggregate.rs` 测试模块追加：

```rust
    #[test]
    #[serial]
    fn find_references_reports_tiers_and_default_flag() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "b", "model": "b-opus"},
            "haiku": {"providerId": "b", "model": "b-haiku"}
        }));
        let db = setup_db(&agg, &[source_provider("a"), source_provider("b")]);

        let refs = find_aggregate_references(&db, "claude", "b").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].aggregate_provider_id, "agg");
        assert_eq!(refs[0].tiers, vec!["opus", "haiku"]);
        assert!(!refs[0].includes_default);

        let refs = find_aggregate_references(&db, "claude", "a").unwrap();
        assert_eq!(refs.len(), 1);
        assert!(refs[0].includes_default);

        assert!(find_aggregate_references(&db, "claude", "nobody").unwrap().is_empty());
    }

    #[test]
    #[serial]
    fn remove_bindings_clears_only_non_default_tiers() {
        let _home = TempHome::new();
        let agg = aggregate_provider(json!({
            "default": {"providerId": "a", "model": "a-default"},
            "opus": {"providerId": "b", "model": "b-opus"},
            "haiku": {"providerId": "b", "model": "b-haiku"}
        }));
        let db = setup_db(&agg, &[source_provider("a"), source_provider("b")]);

        let removed = remove_bindings_to(&db, "claude", "b").unwrap();
        assert_eq!(removed, 2);
        let after = db.get_provider_by_id("agg", "claude").unwrap().unwrap();
        let bindings = AggregateBindings::from_provider(&after).unwrap();
        assert!(bindings.opus.is_none());
        assert!(bindings.haiku.is_none());
        assert!(bindings.default.is_some());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib proxy::aggregate::tests::find_references`
Expected: FAIL（函数未定义）

- [ ] **Step 3: 实现**

`aggregate.rs` 追加：

```rust
/// 一处引用:哪个聚合供应商的哪些档位引用了某供应商
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateReference {
    pub aggregate_provider_id: String,
    pub aggregate_provider_name: String,
    pub tiers: Vec<String>,
    pub includes_default: bool,
}

/// 查找引用了 provider_id 的所有聚合供应商绑定
pub fn find_aggregate_references(
    db: &Database,
    app_type: &str,
    provider_id: &str,
) -> Result<Vec<AggregateReference>, AppError> {
    let all = db.get_all_providers(app_type)?;
    let mut refs = Vec::new();
    for (id, provider) in all.iter() {
        if !is_aggregate_provider(provider) {
            continue;
        }
        let Some(bindings) = AggregateBindings::from_provider(provider) else {
            continue;
        };
        let mut tiers = Vec::new();
        let mut includes_default = false;
        if bindings.default.as_ref().is_some_and(|b| b.provider_id == provider_id) {
            tiers.push("default".to_string());
            includes_default = true;
        }
        for (tier, binding) in [
            ("opus", &bindings.opus),
            ("sonnet", &bindings.sonnet),
            ("haiku", &bindings.haiku),
            ("fable", &bindings.fable),
            ("subagent", &bindings.subagent),
        ] {
            if binding.as_ref().is_some_and(|b| b.provider_id == provider_id) {
                tiers.push(tier.to_string());
            }
        }
        if !tiers.is_empty() {
            refs.push(AggregateReference {
                aggregate_provider_id: id.clone(),
                aggregate_provider_name: provider.name.clone(),
                tiers,
                includes_default,
            });
        }
    }
    Ok(refs)
}

/// 从所有聚合供应商中移除对 provider_id 的非 default 档绑定。
/// default 档引用必须由调用方先行阻止(否则聚合供应商会失去兜底)。
/// 返回清除的绑定数量。
pub fn remove_bindings_to(
    db: &Database,
    app_type: &str,
    provider_id: &str,
) -> Result<usize, AppError> {
    let all = db.get_all_providers(app_type)?;
    let mut removed = 0usize;
    for (_, provider) in all.iter() {
        if !is_aggregate_provider(provider) {
            continue;
        }
        let Some(mut bindings) = AggregateBindings::from_provider(provider) else {
            continue;
        };
        let mut dirty = false;
        for slot in [
            &mut bindings.opus,
            &mut bindings.sonnet,
            &mut bindings.haiku,
            &mut bindings.fable,
            &mut bindings.subagent,
        ] {
            if slot.as_ref().is_some_and(|b| b.provider_id == provider_id) {
                *slot = None;
                removed += 1;
                dirty = true;
            }
        }
        if dirty {
            let mut updated = provider.clone();
            updated.settings_config["aggregate"] =
                serde_json::to_value(&bindings).map_err(|e| AppError::JsonSerialize { source: e })?;
            db.save_provider(app_type, &updated)?;
        }
    }
    Ok(removed)
}
```

`ProviderService`(`services/provider/mod.rs` @4800 附近）:

```rust
    pub fn delete(state: &AppState, app_type: AppType, id: &str) -> Result<(), AppError> {
        Self::delete_with_cascade(state, app_type, id, false)
    }

    /// cascade = true 时清除聚合供应商对该供应商的非 default 档绑定后再删除;
    /// default 档引用始终阻止删除(需先编辑聚合供应商)。
    pub fn delete_with_cascade(
        state: &AppState,
        app_type: AppType,
        id: &str,
        cascade: bool,
    ) -> Result<(), AppError> {
        use crate::proxy::aggregate;
        let refs = aggregate::find_aggregate_references(&state.db, app_type.as_str(), id)?;
        if !refs.is_empty() {
            let names = refs
                .iter()
                .map(|r| r.aggregate_provider_name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            if refs.iter().any(|r| r.includes_default) {
                return Err(AppError::localized(
                    "provider.referenced_by_aggregate_default",
                    format!("该供应商是聚合供应商「{names}」的 default 档来源,请先修改对应聚合供应商"),
                    format!("Provider is the default tier source of aggregate provider(s): {names}"),
                ));
            }
            if !cascade {
                return Err(AppError::localized(
                    "provider.referenced_by_aggregate",
                    format!("该供应商被聚合供应商「{names}」引用"),
                    format!("Provider is referenced by aggregate provider(s): {names}"),
                ));
            }
            aggregate::remove_bindings_to(&state.db, app_type.as_str(), id)?;
        }
        // ……原 delete 函数体其余部分原样保留……
    }
```

（把原 `delete` 的全部既有逻辑移入 `delete_with_cascade` 尾部，`delete` 变成一行委托。)

`commands/provider.rs`:`delete_provider` 签名加 `#[allow(non_snake_case)] cascade: Option<bool>`，调用改为 `ProviderService::delete_with_cascade(state.inner(), app_type, &id, cascade.unwrap_or(false))`；并新增：

```rust
#[tauri::command]
pub fn get_aggregate_references(
    state: State<'_, AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
) -> Result<Vec<crate::proxy::aggregate::AggregateReference>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    crate::proxy::aggregate::find_aggregate_references(
        state.db.as_ref(),
        app_type.as_str(),
        &providerId,
    )
    .map_err(|e| e.to_string())
}
```

`lib.rs` 的 `generate_handler!` 中 `commands::provider::delete_provider,` 下一行加 `commands::provider::get_aggregate_references,`。

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test --features test-hooks`
Expected: PASS（含既有 delete 相关测试回归）

- [ ] **Step 5: 提交**

```bash
cd src-tauri && cargo fmt && cd ..
git add src-tauri/src/proxy/aggregate.rs src-tauri/src/services/provider/mod.rs src-tauri/src/commands/provider.rs src-tauri/src/lib.rs
git commit -m "feat(provider): enforce aggregate reference integrity on delete"
```

---

### Task 6: 切换聚合供应商时注入代理地址

**Files:**
- Modify: `src-tauri/src/services/proxy.rs`(`build_proxy_urls` @1925 改 `pub(crate)`)
- Modify: `src-tauri/src/services/provider/mod.rs`(`switch_normal` 中 provider 取出后注入）

**Interfaces:**
- Consumes: `ProxyService::build_proxy_urls() -> Result<(String, String), String>`（已有，处理 0.0.0.0/IPv6/运行中端口）。
- 行为：非接管模式下切换聚合供应商时，写入 live 的 `env.ANTHROPIC_BASE_URL` 指向本地代理；接管模式下走既有 hot-switch，不经此路径。

- [ ] **Step 1: 写失败测试**

`services/provider/mod.rs` 测试模块（该文件 @147 已有 `TempHome`）追加，参照同文件 @1662 附近既有 live 写入断言的写法：

```rust
    #[test]
    #[serial]
    fn switch_to_aggregate_writes_proxy_base_url_into_live() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let state = AppState::new(db.clone());

        let mut agg = Provider::with_id(
            "agg".to_string(),
            "聚合".to_string(),
            json!({
                "env": {"ANTHROPIC_AUTH_TOKEN": "placeholder"},
                "aggregate": {"default": {"providerId": "a", "model": "a-default"}}
            }),
            None,
        );
        agg.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("aggregate".to_string()),
            ..Default::default()
        });
        let source = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({"env": {}}),
            None,
        );
        db.save_provider("claude", &source).unwrap();
        db.save_provider("claude", &agg).unwrap();

        let switch_hook_outcome = crate::services::ProviderService::switch(&state, AppType::Claude, "agg");
        // 若 switch 需要 test-hooks 入口,改用 commands::provider::switch_provider_test_hook
        assert!(switch_hook_outcome.is_ok(), "switch failed: {:?}", switch_hook_outcome.err());

        let live_path = dirs::home_dir().unwrap().join(".claude").join("settings.json");
        let live: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(live_path).unwrap()).unwrap();
        let base_url = live["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap();
        assert!(base_url.starts_with("http://127.0.0.1:"), "unexpected base url: {base_url}");
    }
```

（如果 live 路径或写入细节与该文件既有测试不同，以既有测试的实际写法为准调整断言路径。)

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib services::provider -- switch_to_aggregate`
Expected: FAIL（当前会写入供应商自身的 env，没有代理地址或断言不成立）

- [ ] **Step 3: 实现**

`services/proxy.rs`:

```rust
    pub(crate) async fn build_proxy_urls(&self) -> Result<(String, String), String> {
```

`services/provider/mod.rs` 的 `switch_normal` 中，`let provider = providers.get(id)...` 之后立即插入：

```rust
        // 聚合供应商本身不持有上游地址:写 live 前把 base URL 指向本地代理,
        // 由代理按档位路由到绑定供应商。代理未运行时使用配置端口,
        // 与「需启动代理才生效」的提示语义一致。
        let provider_owned;
        let provider = if crate::proxy::aggregate::is_aggregate_provider(provider) {
            let mut p = provider.clone();
            let (proxy_url, _) = futures::executor::block_on(state.proxy_service.build_proxy_urls())
                .map_err(AppError::Message)?;
            let mut config = p.settings_config.clone();
            if let Some(env) = config.pointer_mut("/env").and_then(|e| e.as_object_mut()) {
                env.insert(
                    "ANTHROPIC_BASE_URL".to_string(),
                    serde_json::Value::String(proxy_url),
                );
            }
            p.settings_config = config;
            provider_owned = p;
            provider_owned
        } else {
            provider.clone()
        };
        let provider = &provider;
```

注意：若 `switch_normal` 后续代码从 `providers` map 重新按 id 取供应商（而非使用 `provider` 变量），改为在函数开头构造一个注入了代理地址的 `providers` 克隆 map，全程使用克隆。（先读函数体确认实际取值方式，再二选一，不要两处都做。)

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test --lib services::provider && cargo test --test provider_service --test profile_roundtrip`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd src-tauri && cargo fmt && cd ..
git add src-tauri/src/services/proxy.rs src-tauri/src/services/provider/mod.rs
git commit -m "feat(provider): point live base URL at local proxy for aggregate switch"
```

---

### Task 7: 前端能力谓词与常量

**Files:**
- Modify: `src/config/constants.ts`(@11-21 `OAUTH_PROVIDER_TYPES` 附近）
- Modify: `src/utils/providerCapabilities.ts`(`providerNeedsRouting` @116)
- Test: `tests/utils/providerCapabilities.test.ts`（已存在，追加用例）

**Interfaces:**
- Produces: `AGGREGATE_PROVIDER_TYPE = "aggregate"`、`isAggregateProviderType(providerType?: string | null): boolean`;`providerNeedsRouting("claude", aggregateProvider) === true`。

- [ ] **Step 1: 写失败测试**

`tests/utils/providerCapabilities.test.ts` 追加：

```typescript
import { isAggregateProviderType } from "@/config/constants";

describe("aggregate provider", () => {
  it("isAggregateProviderType 只认 aggregate", () => {
    expect(isAggregateProviderType("aggregate")).toBe(true);
    expect(isAggregateProviderType("github_copilot")).toBe(false);
    expect(isAggregateProviderType(undefined)).toBe(false);
  });

  it("Claude 聚合供应商必须走本地路由", () => {
    const provider = {
      id: "agg",
      name: "聚合",
      settingsConfig: { env: {}, aggregate: {} },
      meta: { providerType: "aggregate" },
    } as Provider;
    expect(providerNeedsRouting("claude", provider)).toBe(true);
    expect(providerNeedsRouting("codex", provider)).toBe(false);
    expect(providerNeedsRouting("claude-desktop", provider)).toBe(false);
  });
});
```

（按该文件既有的 import 与 Provider 构造写法对齐。)

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/utils/providerCapabilities.test.ts`
Expected: FAIL(`isAggregateProviderType` 未导出 / 断言失败）

- [ ] **Step 3: 实现**

`constants.ts` 追加：

```typescript
export const AGGREGATE_PROVIDER_TYPE = "aggregate";

/** 聚合供应商:Claude 的模型档位分别绑定不同来源供应商,由本地代理按档路由 */
export function isAggregateProviderType(
  providerType: string | null | undefined,
): boolean {
  return providerType === AGGREGATE_PROVIDER_TYPE;
}
```

`providerCapabilities.ts` 的 `providerNeedsRouting` 中，`const isManagedOAuth = ...` 之后、Claude Desktop 分支之前插入：

```typescript
  // 聚合供应商本身没有上游地址,请求必须经本地代理按档路由(仅 Claude)
  if (appId === "claude" && isAggregateProviderType(provider.meta?.providerType)) {
    return true;
  }
```

（文件头部 import 增加 `isAggregateProviderType`。)

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/utils/providerCapabilities.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
pnpm exec prettier --write src/config/constants.ts src/utils/providerCapabilities.ts tests/utils/providerCapabilities.test.ts
git add src/config/constants.ts src/utils/providerCapabilities.ts tests/utils/providerCapabilities.test.ts
git commit -m "feat(providers): recognize aggregate provider type in routing predicates"
```

---

### Task 8: 聚合档位绑定编辑组件 `AggregateBindingsFields`

**Files:**
- Create: `src/components/providers/forms/AggregateBindingsFields.tsx`
- Test: `tests/components/AggregateBindingsFields.test.tsx`

**Interfaces:**
- Consumes: `useProvidersQuery`(@`src/lib/query/queries.ts:56`)、`isAggregateProviderType`(Task 7)、shadcn `Select` / `Input` / `Label`(`@/components/ui/...`)。
- Produces（Task 9 依赖）:
  - `AGGREGATE_TIERS = ["default", "opus", "sonnet", "haiku", "fable", "subagent"] as const`、`AggregateTier`、`AggregateBinding`、`AggregateBindings` 类型
  - `parseAggregateBindings(settingsConfig: string): AggregateBindings`
  - `synthesizeAggregateEnv(bindings: AggregateBindings): Record<string, string>`
  - `<AggregateBindingsFields settingsConfig onConfigChange currentProviderId? />`

- [ ] **Step 1: 写失败测试**

`tests/components/AggregateBindingsFields.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import {
  parseAggregateBindings,
  synthesizeAggregateEnv,
} from "@/components/providers/forms/AggregateBindingsFields";

describe("parseAggregateBindings", () => {
  it("解析合法绑定并跳过坏档", () => {
    const cfg = JSON.stringify({
      aggregate: {
        default: { providerId: "a", model: "a-x" },
        opus: { providerId: "b", model: "b-y" },
        haiku: { providerId: "", model: "" },
        fable: "oops",
      },
    });
    const bindings = parseAggregateBindings(cfg);
    expect(bindings.default).toEqual({ providerId: "a", model: "a-x" });
    expect(bindings.opus).toEqual({ providerId: "b", model: "b-y" });
    expect(bindings.haiku).toBeUndefined();
    expect(bindings.fable).toBeUndefined();
  });

  it("坏 JSON / 缺 aggregate 返回空对象", () => {
    expect(parseAggregateBindings("not-json")).toEqual({});
    expect(parseAggregateBindings("{}")).toEqual({});
  });
});

describe("synthesizeAggregateEnv", () => {
  it("生成规范档名;subagent 仅在绑定时写入;不含 ANTHROPIC_MODEL", () => {
    const env = synthesizeAggregateEnv({
      default: { providerId: "a", model: "a-x" },
      subagent: { providerId: "b", model: "b-s" },
    });
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-5");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-5");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5");
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("cc-switch-subagent");
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(
      synthesizeAggregateEnv({ default: { providerId: "a", model: "a-x" } })
        .CLAUDE_CODE_SUBAGENT_MODEL,
    ).toBeUndefined();
  });
});
```

（设计说明：不写 `ANTHROPIC_MODEL`——留空时 Claude Code 用内置默认模型，档分类自然落到 sonnet 档；`default` 档只兜底未知模型名。)

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/components/AggregateBindingsFields.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/components/providers/forms/AggregateBindingsFields.tsx`:

```tsx
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProvidersQuery } from "@/lib/query";
import { isAggregateProviderType } from "@/config/constants";

export const AGGREGATE_TIERS = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "subagent",
] as const;
export type AggregateTier = (typeof AGGREGATE_TIERS)[number];

export interface AggregateBinding {
  providerId: string;
  model: string;
}
export type AggregateBindings = Partial<Record<AggregateTier, AggregateBinding>>;

/** 写入 live 的规范档名:只承担「让 Claude Code 按档发出可分类模型名」的职责 */
export const AGGREGATE_CANONICAL_TIER_MODELS: Record<
  Exclude<AggregateTier, "default" | "subagent">,
  string
> = {
  opus: "claude-opus-4-5",
  sonnet: "claude-sonnet-4-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
};

const SUBAGENT_MARKER = "cc-switch-subagent";

export function parseAggregateBindings(settingsConfig: string): AggregateBindings {
  try {
    const cfg = settingsConfig ? JSON.parse(settingsConfig) : {};
    const raw = cfg?.aggregate;
    if (!raw || typeof raw !== "object") return {};
    const out: AggregateBindings = {};
    for (const tier of AGGREGATE_TIERS) {
      const b = (raw as Record<string, unknown>)[tier];
      if (!b || typeof b !== "object") continue;
      const providerId = (b as AggregateBinding).providerId;
      const model = (b as AggregateBinding).model;
      if (
        typeof providerId === "string" &&
        providerId.trim() &&
        typeof model === "string" &&
        model.trim()
      ) {
        out[tier] = { providerId: providerId.trim(), model: model.trim() };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function synthesizeAggregateEnv(
  bindings: AggregateBindings,
): Record<string, string> {
  const env: Record<string, string> = { ...AGGREGATE_CANONICAL_TIER_MODELS };
  if (bindings.subagent) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = SUBAGENT_MARKER;
  }
  return env;
}

interface AggregateBindingsFieldsProps {
  settingsConfig: string;
  onConfigChange: (config: string) => void;
  /** 编辑场景下排除自身,防止自引用 */
  currentProviderId?: string;
}

export function AggregateBindingsFields({
  settingsConfig,
  onConfigChange,
  currentProviderId,
}: AggregateBindingsFieldsProps) {
  const { t } = useTranslation();
  const { data: providers } = useProvidersQuery("claude", true);

  // 来源候选:排除聚合供应商(防嵌套/循环)、官方供应商(防封号风险)、自身
  const candidates = useMemo(
    () =>
      Object.values(providers ?? {}).filter(
        (p) =>
          !isAggregateProviderType(p.meta?.providerType) &&
          p.category !== "official" &&
          p.id !== currentProviderId,
      ),
    [providers, currentProviderId],
  );

  const bindings = parseAggregateBindings(settingsConfig);

  const updateTier = (tier: AggregateTier, patch: Partial<AggregateBinding>) => {
    const next: AggregateBindings = { ...bindings };
    const merged: AggregateBinding = {
      providerId: patch.providerId ?? next[tier]?.providerId ?? "",
      model: patch.model ?? next[tier]?.model ?? "",
    };
    if (!merged.providerId || !merged.model) {
      // 未配齐的档不持久化(模型名可暂空编辑,清空供应商则整档移除)
      if (!merged.providerId) delete next[tier];
      else next[tier] = merged;
    } else {
      next[tier] = merged;
    }
    try {
      const cfg = settingsConfig ? JSON.parse(settingsConfig) : {};
      cfg.aggregate = next;
      cfg.env = synthesizeAggregateEnv(next);
      onConfigChange(JSON.stringify(cfg, null, 2));
    } catch {
      // settingsConfig 损坏时用全新骨架
      onConfigChange(
        JSON.stringify({ env: synthesizeAggregateEnv(next), aggregate: next }, null, 2),
      );
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("provider.aggregate.hint", {
          defaultValue:
            "聚合供应商本身不配置上游地址和密钥;每个模型档分别绑定一个来源供应商。default 档必填,作为未配置档与未知模型的兜底。",
        })}
      </p>
      {AGGREGATE_TIERS.map((tier) => {
        const binding = bindings[tier];
        return (
          <div key={tier} className="grid grid-cols-[6rem_1fr_1fr] items-center gap-2">
            <Label>
              {t(`provider.aggregate.tier.${tier}`, { defaultValue: tier })}
              {tier === "default" && <span className="text-destructive"> *</span>}
            </Label>
            <Select
              value={binding?.providerId ?? ""}
              onValueChange={(value) => updateTier(tier, { providerId: value })}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("provider.aggregate.selectProvider", {
                    defaultValue: "选择来源供应商",
                  })}
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={binding?.model ?? ""}
              placeholder={t("provider.aggregate.modelName", {
                defaultValue: "上游模型名",
              })}
              onChange={(e) => updateTier(tier, { model: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}
```

注意：先读 `useProvidersQuery` 的签名（`src/lib/query/queries.ts:56`）确认第二个参数（enabled 之类）再调用；若签名不同，按其真实签名调整。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/components/AggregateBindingsFields.test.tsx && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
pnpm exec prettier --write src/components/providers/forms/AggregateBindingsFields.tsx tests/components/AggregateBindingsFields.test.tsx
git add src/components/providers/forms/AggregateBindingsFields.tsx tests/components/AggregateBindingsFields.test.tsx
git commit -m "feat(providers): add aggregate tier bindings editor component"
```

---

### Task 9: ProviderForm 集成聚合模式

**Files:**
- Modify: `src/components/providers/forms/ProviderForm.tsx`（锚点：`initialProviderType` @794、`providerType` 构造 @1706-1727、`<BasicFormFields` @2158、`<ClaudeFormFields` @2362)
- Test: `tests/components/AggregateProviderForm.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 8 全部导出；Task 7 的 `AGGREGATE_PROVIDER_TYPE`。
- 行为：仅 `appId === "claude"` 且新增（无 `initialData`）时出现「聚合供应商」开关；编辑聚合供应商时直接进聚合模式且不显示开关（已建供应商不改类型）。

- [ ] **Step 1: 写失败测试**

`tests/components/AggregateProviderForm.test.tsx`：用 `@testing-library/react` 渲染聚合模式下的表单，断言：①提交时 `meta.providerType === "aggregate"`;②未配 default 档时提交被拦截并显示 `provider.aggregate.defaultRequired` 文案。参照 `tests/components/` 既有表单测试的 MSW/render 写法（先读一个既有文件对齐）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/components/AggregateProviderForm.test.tsx`
Expected: FAIL（聚合模式不存在）

- [ ] **Step 3: 实现**

在 `ProviderForm.tsx`:

1. 状态（其他 `useState` 附近）:

```tsx
const [aggregateMode, setAggregateMode] = useState(
  () => appId === "claude" && initialData?.meta?.providerType === "aggregate",
);
```

2. 开关 UI（仅 `appId === "claude" && !initialData && !isCopilot/OAuth 类预设选中` 时渲染；放在预设选择器区块之后）:

```tsx
{appId === "claude" && !initialData && (
  <label className="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      checked={aggregateMode}
      onChange={(e) => {
        const on = e.target.checked;
        setAggregateMode(on);
        if (on) {
          form.setValue(
            "settingsConfig",
            JSON.stringify({ env: synthesizeAggregateEnv({}), aggregate: {} }, null, 2),
          );
        }
      }}
    />
    {t("provider.aggregate.typeLabel", { defaultValue: "聚合供应商(按模型档聚合多个来源)" })}
  </label>
)}
```

3. 条件渲染：把 @2362 的 `<ClaudeFormFields ... />` 包为

```tsx
{aggregateMode ? (
  <AggregateBindingsFields
    settingsConfig={form.watch("settingsConfig")}
    onConfigChange={(config) => form.setValue("settingsConfig", config)}
    currentProviderId={initialData?.id}
  />
) : (
  <ClaudeFormFields ...原有 props 不动... />
)}
```

@2158 的 `<BasicFormFields ... />` 的渲染条件追加 `&& !aggregateMode`（若它外层无显式条件，则用 `{!aggregateMode && (<BasicFormFields ... />)}` 包裹）。预设选择器在 `aggregateMode` 时隐藏（找到 `<ProviderPresetSelector` 渲染处追加 `&& !aggregateMode`)。

4. 提交路径（@1706-1727 构造 `providerType` 处）:

```tsx
const providerType = aggregateMode
  ? AGGREGATE_PROVIDER_TYPE
  : isCopilotProvider /* …原逻辑保持不变… */;
```

提交前校验（在 `providerType` 构造之前）:

```tsx
if (aggregateMode) {
  const bindings = parseAggregateBindings(form.getValues("settingsConfig"));
  if (!bindings.default) {
    toast.error(
      t("provider.aggregate.defaultRequired", {
        defaultValue: "聚合供应商必须配置 default 档作为兜底",
      }),
    );
    return;
  }
}
```

（`toast` 与 `t` 在该文件中已有；若无 `toast` import，参照文件内其他提交拦截处的既有提示方式。)

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/components/AggregateProviderForm.test.tsx tests/components/AggregateBindingsFields.test.tsx && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
pnpm exec prettier --write src/components/providers/forms/ProviderForm.tsx tests/components/AggregateProviderForm.test.tsx
git add src/components/providers/forms/ProviderForm.tsx tests/components/AggregateProviderForm.test.tsx
git commit -m "feat(providers): integrate aggregate mode into Claude provider form"
```

---

### Task 10: ProviderCard 聚合徽标与摘要

**Files:**
- Modify: `src/components/providers/ProviderCard.tsx`（徽标渲染处参照既有 `isPartner` 等 badge 写法，先读后写）
- Modify: `src/components/providers/ProviderList.tsx`（若 ProviderCard 拿不到全量供应商表，在此计算摘要字符串后透传 prop)
- Test: `tests/components/AggregateProviderCard.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

渲染一个 `meta.providerType === "aggregate"` 的卡片，断言出现「聚合」徽标文案与摘要（如 `default→A · opus→B`)；摘要中的供应商名来自传入的 providers 表。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/components/AggregateProviderCard.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

- `ProviderList.tsx`：为聚合供应商计算 `aggregateSummary`(`parseAggregateBindings(JSON.stringify(provider.settingsConfig))` + providers 表查名，按 `default/opus/sonnet/haiku/fable/subagent` 顺序拼接 `档→名`)，作为 prop 传给 `ProviderCard`。
- `ProviderCard.tsx`:`provider.meta?.providerType === AGGREGATE_PROVIDER_TYPE` 时渲染「聚合」badge（复用既有 badge 组件与样式）与 `aggregateSummary` 一行小字。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/components/AggregateProviderCard.test.tsx && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
pnpm exec prettier --write src/components/providers/ProviderCard.tsx src/components/providers/ProviderList.tsx tests/components/AggregateProviderCard.test.tsx
git add -A
git commit -m "feat(providers): show aggregate badge and tier summary on provider card"
```

---

### Task 11: 删除确认流程（前端）

**Files:**
- Modify: `src/lib/api/providers.ts`(@78 `delete` 附近）
- Modify: `src/hooks/useProviderActions.ts`(`deleteProvider` @353-359)
- Modify: 删除确认的宿主组件（第一步用 codegraph 定位：`ConfirmDialog deleteProvider`，大概率在 `ProviderList.tsx` 或 `ProviderCard.tsx`)
- Test: 在宿主组件对应测试文件中追加用例

**Interfaces:**
- Consumes: Task 5 的后端命令 `get_aggregate_references` / `delete_provider(cascade)`。
- Produces: `providersApi.getAggregateReferences(id, appId): Promise<AggregateReference[]>`;`providersApi.delete(id, appId, cascade?)`。

- [ ] **Step 1: 写失败测试**

MSW mock `get_aggregate_references` 返回一条非 default 引用 → 点击删除出现确认文案（含聚合供应商名）→ 确认后收到 `delete_provider` 且参数 `cascade: true`;mock 返回空数组 → 直接走原确认/删除，无新增文案。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run <宿主测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/lib/api/providers.ts`:

```typescript
export interface AggregateReference {
  aggregateProviderId: string;
  aggregateProviderName: string;
  tiers: string[];
  includesDefault: boolean;
}

// providersApi 内:
  async getAggregateReferences(
    id: string,
    appId: AppId,
  ): Promise<AggregateReference[]> {
    return await invoke("get_aggregate_references", { app: appId, providerId: id });
  },
```

`delete` 改为：

```typescript
  async delete(id: string, appId: AppId, cascade?: boolean): Promise<boolean> {
    return await invoke("delete_provider", { id, app: appId, cascade });
  },
```

`useProviderActions.ts` 的 `deleteProvider` 保持签名不变，但删除确认宿主组件在弹出既有确认框**之前**:

```typescript
const refs = await providersApi.getAggregateReferences(provider.id, activeApp);
if (refs.length > 0) {
  // 展示聚合引用确认框:列出 refs 中每个 aggregateProviderName 与 tiers;
  // 文案 provider.aggregate.deleteReferencedTitle / deleteReferencedMessage;
  // 确认 → providersApi.delete(id, activeApp, true)
  // default 档引用会被后端拒绝,错误 toast 走既有 mutation onError 通道
} else {
  // 既有删除确认流程不变
}
```

（若 `includesDefault` 为 true 的引用，确认框文案追加提示需先编辑聚合供应商；后端兜底仍会拒绝。)

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/components tests/hooks && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
pnpm exec prettier --write src/lib/api/providers.ts src/hooks/useProviderActions.ts <宿主组件与测试>
git add -A
git commit -m "feat(providers): confirm and cascade aggregate references on delete"
```

---

### Task 12: i18n 四语言文案

**Files:**
- Modify: `src/i18n/locales/zh.json`、`zh-TW.json`、`en.json`、`ja.json`

- [ ] **Step 1: 汇总本特性全部新 key 并写入四个 locale**

| key | zh | zh-TW | en | ja |
|---|---|---|---|---|
| `provider.aggregate.typeLabel` | 聚合供应商（按模型档聚合多个来源） | 聚合供應商（按模型檔聚合多個來源） | Aggregate provider (per-tier sourcing) | 集約プロバイダー(モデル層ごとに集約) |
| `provider.aggregate.hint` | 聚合供应商本身不配置上游地址和密钥；每个模型档分别绑定一个来源供应商。default 档必填，作为未配置档与未知模型的兜底。 | 聚合供應商本身不配置上游位址與金鑰;每個模型檔分別綁定一個來源供應商。default 檔必填,作為未配置檔與未知模型的兜底。 | An aggregate provider has no upstream URL/key of its own; each model tier binds to a source provider. The default tier is required as fallback. | 集約プロバイダー自体には上流 URL/キーを設定しません。各モデル層がソースプロバイダーに紐付きます。default 層は必須です。 |
| `provider.aggregate.selectProvider` | 选择来源供应商 | 選擇來源供應商 | Select source provider | ソースプロバイダーを選択 |
| `provider.aggregate.modelName` | 上游模型名 | 上游模型名 | Upstream model name | 上流モデル名 |
| `provider.aggregate.defaultRequired` | 聚合供应商必须配置 default 档作为兜底 | 聚合供應商必須配置 default 檔作為兜底 | Aggregate provider requires a default tier binding | 集約プロバイダーには default 層の設定が必要です |
| `provider.aggregate.badge` | 聚合 | 聚合 | Aggregate | 集約 |
| `provider.aggregate.deleteReferencedTitle` | 该供应商被聚合供应商引用 | 該供應商被聚合供應商引用 | Provider referenced by aggregate provider | このプロバイダーは集約プロバイダーから参照されています |
| `provider.aggregate.deleteReferencedMessage` | 删除后将同时清除以下聚合绑定： | 刪除後將同時清除以下聚合綁定: | Deleting will also remove these aggregate bindings: | 削除すると以下の集約バインドも削除されます: |
| `notifications.proxyReasonAggregate` | 使用跨供应商模型聚合 | 使用跨供應商模型聚合 | uses cross-provider model aggregation | クロスプロバイダーのモデル集約を使用 |
| `provider.aggregate.tier.default` | default（兜底） | default(兜底) | default (fallback) | default(フォールバック) |
| `provider.aggregate.tier.subagent` | subagent（子代理） | subagent(子代理) | subagent | subagent(サブエージェント) |

(opus / sonnet / haiku / fable 档名四语言均直接用原名，无需翻译条目——但若 `localeCoverage` 要求 key 对称，则四个文件都写上原名。)

- [ ] **Step 2: 切换提示接入**

`src/hooks/useProviderActions.ts` 的 `switchProvider` 中 `proxyRequiredReason` 判定链，在 Copilot 分支前追加：

```typescript
      if (isAggregateProviderType(provider.meta?.providerType)) {
        proxyRequiredReason = t("notifications.proxyReasonAggregate", {
          defaultValue: "使用跨供应商模型聚合",
        });
      } else if (isCopilotProvider) { …原逻辑…
```

（把原来的 `if (isCopilotProvider)` 改为 `else if` 链的一员；`isAggregateProviderType` 从 `@/config/constants` import。)

- [ ] **Step 3: 运行 locale 覆盖测试**

Run: `pnpm vitest run tests/config/localeCoverage.test.ts tests/config/managementListLocales.test.ts tests/config/toolManagementLocales.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
pnpm exec prettier --write src/i18n/locales/*.json src/hooks/useProviderActions.ts
git add src/i18n/locales src/hooks/useProviderActions.ts
git commit -m "feat(i18n): add aggregate provider strings in zh/zh-TW/en/ja"
```

---

### Task 13: 全量验证与手动冒烟

- [ ] **Step 1: 自动化全绿**

```bash
pnpm typecheck
pnpm test:unit
cd src-tauri && cargo clippy && cargo test --features test-hooks && cd ..
```

Expected: 全部通过。若有既有测试因签名变化（`delete_provider` 加参数、`forward_with_retry` 加参数）失败，按新签名修正调用（属本计划内改动，不算回归）。

- [ ] **Step 2: 手动冒烟清单**(`pnpm dev` 启动）

1. Claude 下新建两个普通供应商 A、B（可乱填 base URL/key)；新建聚合供应商：default→A(a-x)、opus→B(b-y)、haiku→A(a-z);default 档留空时保存被拦截。
2. 供应商列表显示「聚合」徽标与摘要；切换到聚合供应商，出现「需要代理」提示；启动代理接管。
3. `curl http://127.0.0.1:<port>/v1/messages` 分别发 `claude-opus-4-5` / `claude-haiku-4-5` / `unknown-model`，在代理请求日志中确认分别命中 B / A / A(default 兜底）。
4. 删除 B：弹确认框列出聚合引用 → 确认后 B 删除、聚合供应商的 opus 档绑定被清除；删除 A：被阻止（default 档引用）。
5. 用量页确认请求按实际上游供应商归因。

- [ ] **Step 3: 最终提交（如有修正）**

```bash
git add -A && git commit -m "test: verify aggregate provider end to end"
```

---

## Self-Review 记录

- **Spec 覆盖**:9 项设计决策均有对应任务——虚拟类型/存储(T2/T8/T9)、档分类与回退链(T1/T2)、default 兜底(T2/T4)、直接失败(T3 无跨档重试）、引用完整性(T5/T11)、代理地址注入(T6)、badge/摘要(T10)、i18n(T12)、成功标准 1-6(T13 冒烟对应）。
- **类型一致性**:`AggregateBinding{providerId, model}`(Rust serde `providerId` ↔ TS `providerId`)、`AggregateReference` camelCase ↔ TS 接口、`pre_mapped` 透传链、`validate_bindings` 参数序，已逐任务核对。
- **有意的范围削减**(YAGNI):v1 不做「拉取模型」辅助按钮（手填即可，model_fetch 接入留作后续）、不做档内备用供应商、聚合供应商不进故障转移队列。
