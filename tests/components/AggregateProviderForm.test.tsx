import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { setProviders } from "../msw/state";
import { createTestQueryClient } from "../utils/testQueryClient";

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastMocks.error,
    success: vi.fn(),
  },
}));

// ClaudeFormFields 在开启聚合开关前会短暂挂载，屏蔽其外部请求
// （与 ClaudeFormFields.test.tsx 的写法对齐）
vi.mock("@/lib/api/copilot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/copilot")>();
  return {
    ...actual,
    copilotGetModels: vi.fn().mockResolvedValue([]),
    copilotGetModelsForAccount: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/api/model-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/model-fetch")>();
  return {
    ...actual,
    fetchCodexOauthModels: vi.fn().mockResolvedValue([]),
    fetchModelsForConfig: vi.fn().mockResolvedValue([]),
    showFetchModelsError: vi.fn(),
  };
});

vi.mock("@/components/providers/forms/CopilotAuthSection", () => ({
  CopilotAuthSection: () => <div data-testid="copilot-auth-section" />,
}));

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: () => <div data-testid="codex-oauth-section" />,
}));

vi.mock("@/components/providers/forms/ProviderAdvancedConfig", () => ({
  ProviderAdvancedConfig: () => <div data-testid="advanced-config" />,
}));

// 屏蔽与聚合模式无关的异步副作用，保证 settingsConfig 内容确定：
// useCommonConfigSnippet 真实实现会异步加载 config.json 并自动合并通用配置片段
vi.mock("@/components/providers/forms/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/forms/hooks")>();
  return {
    ...actual,
    useCopilotAuth: () => ({
      isAuthenticated: false,
      isStatusSuccess: true,
      isStatusError: false,
      accounts: [],
    }),
    useCodexOauth: () => ({
      isAuthenticated: false,
      isStatusSuccess: true,
      isStatusError: false,
      defaultAccountId: null,
      accounts: [],
    }),
    useXaiOauth: () => ({
      isAuthenticated: false,
      accounts: [],
    }),
    useCommonConfigSnippet: () => ({
      useCommonConfig: false,
      commonConfigSnippet: "",
      commonConfigError: null,
      isLoading: false,
      isExtracting: false,
      handleCommonConfigToggle: vi.fn(),
      handleCommonConfigSnippetChange: vi.fn(),
      handleExtract: vi.fn(),
    }),
  };
});

vi.mock("@/lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query")>();
  return {
    ...actual,
    useSettingsQuery: () => ({
      data: { commonConfigConfirmed: true },
    }),
  };
});

const AGGREGATE_TOGGLE_LABEL = "聚合供应商(按模型档聚合多个来源)";

type InitialData = ComponentProps<typeof ProviderForm>["initialData"];

function renderClaudeForm(
  onSubmit: (values: ProviderFormValues) => void,
  initialData?: InitialData,
) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderForm
        appId="claude"
        submitLabel="save-provider"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={initialData}
      />
    </QueryClientProvider>,
  );
}

async function enableAggregateMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("checkbox", { name: AGGREGATE_TOGGLE_LABEL }),
  );
  // 等待档位编辑器出现（候选供应商列表来自 useProvidersQuery 的异步加载）
  await screen.findByText(/聚合供应商本身不配置上游地址/);
}

function fillProviderName(name: string) {
  fireEvent.change(screen.getByLabelText("provider.name"), {
    target: { value: name },
  });
}

describe("ProviderForm 聚合供应商模式", () => {
  beforeEach(() => {
    // Radix Select 展开时需要 scrollIntoView（jsdom 未实现）
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    toastMocks.error.mockReset();
    setProviders("claude", {
      pa: {
        id: "pa",
        name: "Provider A",
        settingsConfig: {},
        category: "custom",
        sortIndex: 0,
        createdAt: 1,
      },
      pb: {
        id: "pb",
        name: "Provider B",
        settingsConfig: {},
        category: "custom",
        sortIndex: 1,
        createdAt: 2,
      },
    });
  });

  it("新建 Claude 供应商开启聚合模式后提交，meta.providerType 为 aggregate", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderClaudeForm(onSubmit);

    await enableAggregateMode(user);
    fillProviderName("聚合测试");

    // 档位顺序：default, opus, sonnet, haiku, fable, subagent —— default 为第 1 行
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Provider A" }));
    fireEvent.change(screen.getAllByPlaceholderText("上游模型名")[0], {
      target: { value: "a-default" },
    });

    await user.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(submitted.meta?.providerType).toBe("aggregate");
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.aggregate.default).toEqual({
      providerId: "pa",
      model: "a-default",
    });
    // 兜底环境变量（规范档名）随绑定写入 live 配置
    expect(settingsConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      "claude-opus-4-5",
    );
  });

  it("未配置 default 档时提交被拦截并提示", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderClaudeForm(onSubmit);

    await enableAggregateMode(user);
    fillProviderName("聚合测试");

    await user.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "聚合供应商必须配置 default 档作为兜底",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("default 档已选来源但模型名为空时提交被拦截并提示补全", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderClaudeForm(onSubmit);

    await enableAggregateMode(user);
    fillProviderName("聚合测试");

    // 只选来源供应商，不填模型名（parseAggregateBindings 会保留该部分档）
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Provider A" }));

    await user.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "请为 default 档填写上游模型名",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("编辑聚合供应商时不显示类型开关，提交保持 aggregate 类型", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderClaudeForm(onSubmit, {
      name: "既有聚合",
      category: "third_party",
      settingsConfig: {
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5" },
        aggregate: { default: { providerId: "pa", model: "a-default" } },
      },
      meta: { providerType: "aggregate" },
    });

    // 已建供应商不允许改类型：开关不渲染，但档位编辑器直接可见
    expect(
      screen.queryByRole("checkbox", { name: AGGREGATE_TOGGLE_LABEL }),
    ).not.toBeInTheDocument();
    await screen.findByText(/聚合供应商本身不配置上游地址/);

    await user.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(submitted.meta?.providerType).toBe("aggregate");
    expect(submitted.name).toBe("既有聚合");
  });
});
