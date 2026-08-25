import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AggregateBindingsFields,
  parseAggregateBindings,
  synthesizeAggregateEnv,
} from "@/components/providers/forms/AggregateBindingsFields";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/query", () => ({
  useProvidersQuery: () => ({
    data: {
      providers: {
        pa: { id: "pa", name: "Provider A" },
        pb: { id: "pb", name: "Provider B" },
      },
      currentProviderId: null,
    },
  }),
}));

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

  it("保留仅配了供应商的部分档(model 暂空)", () => {
    const cfg = JSON.stringify({
      aggregate: { opus: { providerId: "a", model: "" } },
    });
    expect(parseAggregateBindings(cfg).opus).toEqual({
      providerId: "a",
      model: "",
    });
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

  it("subagent 仅配供应商未配模型时不写入标记", () => {
    const env = synthesizeAggregateEnv({
      default: { providerId: "a", model: "a-x" },
      subagent: { providerId: "b", model: "" },
    });
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });
});

describe("AggregateBindingsFields 受控回写交互", () => {
  /** 模拟 ProviderForm 的即时回写:settingsConfig 存于父组件 state */
  function Harness() {
    const [config, setConfig] = useState("{}");
    return (
      <>
        <AggregateBindingsFields
          settingsConfig={config}
          onConfigChange={setConfig}
        />
        <output data-testid="settings-config">{config}</output>
      </>
    );
  }

  it("新档先选供应商再输入模型名,回写后选择不丢失且最终持久化完整绑定", async () => {
    // Radix Select 展开时需要 scrollIntoView(jsdom 未实现)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    render(<Harness />);

    // 档位顺序:default, opus, sonnet, haiku, fable, subagent —— opus 为第 2 行
    // 先选供应商(model 为空的部分档也必须在回写后保留)
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "Provider A" }));

    // 回写重渲染后 Select 仍显示所选供应商(修复前会弹回空)
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("Provider A");

    // 再输入模型名
    fireEvent.change(
      screen.getAllByPlaceholderText("provider.aggregate.modelName")[1],
      { target: { value: "a-x" } },
    );

    const cfg = JSON.parse(
      screen.getByTestId("settings-config").textContent ?? "{}",
    );
    expect(cfg.aggregate.opus).toEqual({ providerId: "pa", model: "a-x" });
  });
});
