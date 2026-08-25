# Claude 聚合供应商（跨供应商模型路由）设计

- 日期：2026-08-25
- 状态：已批准（brainstorming 阶段完成）
- 范围：仅 Claude 应用；其余 8 个 AppType 不受影响

## 背景

Claude Code 的供应商配置包含 5+1 个模型槽位（`ANTHROPIC_MODEL` 默认档、`ANTHROPIC_DEFAULT_HAIKU_MODEL` / `SONNET` / `OPUS` / `FABLE` 四个具名档、`CLAUDE_CODE_SUBAGENT_MODEL`）。当前这些槽位只能填模型名，所有请求仍发往**同一个**供应商的 base URL + API key。

用户目标：每个槽位可以绑定**不同供应商**的不同模型（例如 opus 档走供应商 A 的模型 a,fable 档走供应商 B 的模型 a,haiku 档走供应商 A 的模型 b),以按档位择优/省钱。

由于 Claude Code 只与单一 `ANTHROPIC_BASE_URL` 通信，跨供应商路由必须经过本应用的本地代理（接管模式）。代理已具备：按档模型名映射（`proxy/model_mapper.rs`)、故障转移队列与熔断器（`proxy/provider_router.rs`、`proxy/circuit_breaker.rs`)、按供应商的格式转换管线（OpenAI Chat/Responses ↔ Anthropic Messages)。

## 关键决策（与用户确认）

| 决策点 | 结论 |
|--------|------|
| 应用范围 | 只做 Claude |
| 配置形态 | 新增「聚合供应商」虚拟供应商类型（`meta.providerType = "aggregate"`)，档位绑定存于该供应商的 `settings_config` JSON,**零 DB 迁移** |
| 未配置档位 / 未知模型名 | 走 default 档绑定；**default 档必填**作为兜底（与现有 fable→opus→default 回退链一致） |
| 绑定供应商请求失败 / 熔断 | 该档请求直接失败并返回原始错误，**不跨档回退**；熔断器仍按 `(app, providerId)` 维度工作 |

被否决的备选：扩展普通供应商表单（代理关闭时写入 live 的模型名会发往错误上游，语义有坑）；独立路由表面板 + 新 DB 表（发现性差、需迁移）；档内备用供应商列表（v1 复杂度过高，与全局故障转移队列概念重叠）。

## 数据模型

聚合供应商是一条普通的 `Provider` 记录（`providers` 表），通过 `meta.providerType = "aggregate"` 识别。其 `settings_config`:

```jsonc
{
  "env": {
    // 切换时写入 live 配置的部分。由后端自动生成规范档名，
    // 保证 Claude Code 发出的模型名能被代理的档分类器按关键字识别。
    "ANTHROPIC_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  },
  "aggregate": {
    // 档 → 来源绑定；default 必填，其余选填
    "default":  { "providerId": "a", "model": "a的模型x" },
    "opus":     { "providerId": "a", "model": "a的模型a" },
    "fable":    { "providerId": "b", "model": "b的模型a" },
    "haiku":    { "providerId": "a", "model": "a的模型b" },
    "sonnet":   { "providerId": "c", "model": "c的模型z" },
    "subagent": { "providerId": "a", "model": "a的模型s" }
  }
}
```

- 档位枚举：`default | opus | sonnet | haiku | fable | subagent`。
- 绑定里的 `model` 是**发给上游的最终模型名**（显式优先：跳过来源供应商自身的 model_mapper，仅做 `[1M]` 标记剥离等通用处理）。
- `env` 块的值只承担「让 Claude Code 按档发出可分类的模型名」的职责，不参与上游路由。

## 代理路由流程

触发条件：当前供应商是聚合供应商，且代理接管已开启（聚合供应商归入现有 `providerNeedsRouting` 语义，代理未启动时切换会弹引导提示，与 Copilot 类供应商一致）。

```
Claude Code 请求（model: "claude-opus-4-5"）
  → 档分类器（复用 model_mapper 的关键字逻辑与 fable→opus→default 回退链）
  → 判定档位（如 opus）→ 查 settings_config.aggregate 绑定
  → 加载来源供应商（每次请求从 DB 读最新数据），以它的凭证 / base URL /
    格式转换管线转发，请求体 model 重写为绑定模型名
  → 熔断器按来源供应商维度工作；失败直接返回原始错误
  → 用量日志按实际上游供应商归因（复用 proxy_request_logs 的
    original_model / mapped_model 字段）
```

与现有机制的关系：

- **故障转移队列**：聚合供应商接管路由后，该 app 的故障转移队列对其不生效（绑定表即路由）。
- **格式转换混搭**：来源供应商各自走完整的现有转发管线，因此 opus 走 Anthropic 格式中转、haiku 走 OpenAI 格式中转这类混搭天然支持。
- **backfill**：聚合供应商不参与 live 配置回填（编辑当前在用的聚合供应商时以表单为准直接保存）。
- **未知模型名**：档分类器未命中任何具名档时落 default 档（default 必填保证必有兜底）。

## UI 设计

- 「聚合」类型在**添加供应商时**选择；已创建的供应商不改变类型（避免普通供应商改成聚合后原有 base URL / API key 悬空）。聚合供应商的表单隐藏 base URL / API key 输入，改为档位绑定表格。
- 档位表格每行：档名 + **来源供应商下拉**（当前 Claude 应用下的普通供应商，**排除聚合供应商**以防止循环引用）+ **模型名输入框**（可调用现有 `model_fetch` 服务从来源供应商拉 `/models` 列表辅助选择，允许手填）。
- 校验：default 档必填；保存时校验来源供应商仍存在且非聚合类型。
- 供应商卡片显示「聚合」徽标 + 各档来源摘要（如 `opus→A · fable→B · haiku→A`)。
- 切换/排序/托盘菜单与普通供应商一致。

## 引用完整性

| 场景 | 行为 |
|------|------|
| 删除被引用的普通供应商 | 弹确认框列出受影响的聚合供应商与档位；确认后删除并同步清除这些绑定（受影响档回退到 default 档语义） |
| 编辑被引用供应商的凭证/地址 | 无需特殊处理（代理逐请求读 DB 最新数据） |
| 运行时遇到悬空引用（绑定供应商已不存在） | 该档视为未配置 → 落 default 档；default 档悬空则保存/切换时报错阻止 |

## 错误处理

- 绑定供应商失败/熔断：直接返回原始错误，不跨档回退（v1 不引入档内备用列表）。
- default 档未配置或悬空：表单校验与后端保存双重拦截。
- 代理未运行时切换到聚合供应商：允许切换，提示需启动代理才能生效。

## 测试策略

- **Rust 单测**：新 `aggregate_router` 模块——档分类 + 绑定解析（含 fable→opus→default 回退链、悬空引用落 default、subagent 精确匹配、`[1M]` 标记剥离）；删除供应商时的绑定清理。
- **Rust 集成测试**(`src-tauri/tests/`，复用 `provider_router` 测试的内存 DB + `TempHome` 模式）：聚合供应商为当前供应商时按档选出正确来源供应商；故障转移队列对聚合供应商不生效。
- **前端 vitest**：聚合表单校验（default 必填、禁止引用聚合供应商、来源供应商删除后的表单态）、卡片摘要渲染。
- **i18n**:新增 UI 文案补齐 zh / zh-TW / en / ja，确保 `localeCoverage` 类测试通过。

## 实现锚点（现状文件）

- 档分类与模型名映射：`src-tauri/src/proxy/model_mapper.rs`（复用其关键字逻辑）
- 供应商选择与熔断：`src-tauri/src/proxy/provider_router.rs`、`src-tauri/src/proxy/circuit_breaker.rs`
- 转发管线入口：`src-tauri/src/proxy/handlers.rs`、`src-tauri/src/proxy/forwarder.rs`
- 供应商模型与 meta:`src-tauri/src/provider.rs`(`Provider` / `ProviderMeta.provider_type`)
- 删除供应商命令（引用完整性挂钩点）:`src-tauri/src/commands/provider.rs` + `src-tauri/src/services/provider/mod.rs`
- 表单：`src/components/providers/forms/`（新增聚合表单，参考 `ClaudeFormFields.tsx` 与 `hooks/useModelState.ts` 的档位枚举）
- 切换后缓存失效：`src/lib/query/mutations.ts`(`useSwitchProviderMutation` 模式复用，无需改动）
- 模型列表拉取辅助：`src-tauri/src/services/model_fetch.rs` + `src/lib/api/model-fetch.ts`

## 成功标准

1. 可创建聚合供应商：5+1 档各自绑定不同普通供应商与模型，default 档必填校验生效。
2. 切换为聚合供应商并启动代理接管后，Claude Code 按档请求被路由到对应来源供应商，上游收到的模型名为绑定模型名。
3. 未配置档/未知模型名落 default 档；绑定供应商失败时不跨档回退，错误原样返回。
4. 删除被引用供应商时提示并清理绑定；悬空引用档落 default。
5. 用量统计按实际上游供应商归因。
6. `pnpm typecheck`、`pnpm test:unit`、`cargo test` 全绿；新增文案四语言齐全。
