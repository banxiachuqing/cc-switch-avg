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
