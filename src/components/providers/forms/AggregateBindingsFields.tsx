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
export type AggregateBindings = Partial<
  Record<AggregateTier, AggregateBinding>
>;

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

/** 档位 → 写入 live 的 Claude Code 环境变量名 */
const TIER_ENV_KEYS: Record<
  keyof typeof AGGREGATE_CANONICAL_TIER_MODELS,
  string
> = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};

export function parseAggregateBindings(
  settingsConfig: string,
): AggregateBindings {
  try {
    const cfg = settingsConfig ? JSON.parse(settingsConfig) : {};
    const raw = cfg?.aggregate;
    if (!raw || typeof raw !== "object") return {};
    const out: AggregateBindings = {};
    for (const tier of AGGREGATE_TIERS) {
      const b = (raw as Record<string, unknown>)[tier];
      if (!b || typeof b !== "object") continue;
      const providerId = (b as AggregateBinding).providerId;
      // 仅供应商为空时丢弃该档;model 允许暂空(部分档在编辑中间态必须保留,
      // 否则受控回写后 Select 已选值会被弹回空)
      if (typeof providerId !== "string" || !providerId.trim()) continue;
      const model = (b as AggregateBinding).model;
      out[tier] = {
        providerId: providerId.trim(),
        model: typeof model === "string" ? model.trim() : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function synthesizeAggregateEnv(
  bindings: AggregateBindings,
): Record<string, string> {
  // 规范档名恒写入(让 Claude Code 按档发出可分类模型名);不写 ANTHROPIC_MODEL,
  // 留空时 Claude Code 用内置默认模型,档分类自然落到 sonnet 档
  const env: Record<string, string> = {};
  for (const [tier, model] of Object.entries(AGGREGATE_CANONICAL_TIER_MODELS)) {
    env[TIER_ENV_KEYS[tier as keyof typeof TIER_ENV_KEYS]] = model;
  }
  // 部分档(仅配了供应商)只是编辑中间态,不发出 subagent 标记,
  // 避免代理把未配模型的 subagent 请求路由到半成品绑定
  if (bindings.subagent?.model) {
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
  const { data: providersData } = useProvidersQuery("claude");

  // 来源候选:排除聚合供应商(防嵌套/循环)、官方供应商(防封号风险)、自身
  const candidates = useMemo(
    () =>
      Object.values(providersData?.providers ?? {}).filter(
        (p) =>
          !isAggregateProviderType(p.meta?.providerType) &&
          p.category !== "official" &&
          p.id !== currentProviderId,
      ),
    [providersData, currentProviderId],
  );

  const bindings = parseAggregateBindings(settingsConfig);

  const updateTier = (
    tier: AggregateTier,
    patch: Partial<AggregateBinding>,
  ) => {
    const next: AggregateBindings = { ...bindings };
    const merged: AggregateBinding = {
      providerId: patch.providerId ?? next[tier]?.providerId ?? "",
      model: patch.model ?? next[tier]?.model ?? "",
    };
    // 档位按当前字段原样持久化,模型名可暂空编辑(部分档);
    // 仅清空供应商时移除整档
    if (!merged.providerId) delete next[tier];
    else next[tier] = merged;
    try {
      const cfg = settingsConfig ? JSON.parse(settingsConfig) : {};
      cfg.aggregate = next;
      cfg.env = synthesizeAggregateEnv(next);
      onConfigChange(JSON.stringify(cfg, null, 2));
    } catch {
      // settingsConfig 损坏时用全新骨架
      onConfigChange(
        JSON.stringify(
          { env: synthesizeAggregateEnv(next), aggregate: next },
          null,
          2,
        ),
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
          <div
            key={tier}
            className="grid grid-cols-[6rem_1fr_1fr] items-center gap-2"
          >
            <Label>
              {t(`provider.aggregate.tier.${tier}`, { defaultValue: tier })}
              {tier === "default" && (
                <span className="text-destructive"> *</span>
              )}
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
