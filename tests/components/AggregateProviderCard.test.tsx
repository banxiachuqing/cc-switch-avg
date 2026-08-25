import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderList } from "@/components/providers/ProviderList";
import { createTestQueryClient } from "../utils/testQueryClient";

// 与 ProviderCard.codexAccount.test.tsx 一致的卡片级 mock
vi.mock("@/components/providers/ProviderActions", () => ({
  ProviderActions: () => null,
}));

vi.mock("@/components/ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("@/components/UsageFooter", () => ({ default: () => null }));
vi.mock("@/components/SubscriptionQuotaFooter", () => ({
  default: () => null,
}));
vi.mock("@/components/CopilotQuotaFooter", () => ({ default: () => null }));
vi.mock("@/components/CodexOauthQuotaFooter", () => ({ default: () => null }));
vi.mock("@/components/XaiOauthQuotaFooter", () => ({ default: () => null }));

// ProviderCard 与 ProviderList 都会从该模块取 hook,需一并补齐
vi.mock("@/lib/query/failover", () => ({
  useProviderHealth: () => ({ data: undefined }),
  useAutoFailoverEnabled: () => ({ data: false }),
  useFailoverQueue: () => ({ data: [] }),
  useAddToFailoverQueue: () => ({ mutate: vi.fn() }),
  useRemoveFromFailoverQueue: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/query/queries", () => ({
  useUsageQuery: () => ({ data: undefined }),
}));

// 与 ProviderList.test.tsx 一致的列表级 mock:拖拽序直接跟随 providers 表
vi.mock("@/hooks/useDragSort", () => ({
  useDragSort: (providers: Record<string, Provider>) => ({
    sortedProviders: Object.values(providers),
    sensors: [],
    handleDragEnd: vi.fn(),
  }),
}));

vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({
    checkProvider: vi.fn(),
    isChecking: () => false,
  }),
}));

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<any>("@dnd-kit/sortable");
  return {
    ...actual,
    useSortable: () => ({
      setNodeRef: vi.fn(),
      attributes: {},
      listeners: {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

const sourceProviderA: Provider = {
  id: "pa",
  name: "A",
  settingsConfig: {},
};

const sourceProviderB: Provider = {
  id: "pb",
  name: "B",
  settingsConfig: {},
};

const aggregateProvider: Provider = {
  id: "agg",
  name: "Agg",
  settingsConfig: {
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5" },
    aggregate: {
      // 故意把 opus 写在 default 前:摘要顺序必须来自 AGGREGATE_TIERS 而非 JSON 键序
      opus: { providerId: "pb", model: "b-y" },
      default: { providerId: "pa", model: "a-x" },
    },
  },
  meta: { providerType: "aggregate" },
};

const normalProvider: Provider = {
  id: "normal",
  name: "Normal",
  settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://example.com" } },
};

function renderCard(provider: Provider, aggregateSummary?: string) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderCard
        provider={provider}
        appId="claude"
        isCurrent={false}
        isProxyRunning={false}
        aggregateSummary={aggregateSummary}
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onConfigureUsage={vi.fn()}
        onOpenWebsite={vi.fn()}
        onDuplicate={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function renderList(providers: Record<string, Provider>) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderList
        providers={providers}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("ProviderCard 聚合徽标与摘要", () => {
  it("聚合供应商渲染「聚合」徽标与档位摘要", () => {
    renderCard(aggregateProvider, "default→A · opus→B");

    expect(screen.getByText("聚合")).toBeInTheDocument();
    expect(screen.getByText("default→A · opus→B")).toBeInTheDocument();
  });

  it("摘要 prop 为空时只显示徽标、不渲染摘要行", () => {
    renderCard(aggregateProvider);

    expect(screen.getByText("聚合")).toBeInTheDocument();
    expect(screen.queryByText(/default→/)).not.toBeInTheDocument();
  });

  it("普通供应商既不显示「聚合」徽标也不显示摘要", () => {
    renderCard(normalProvider);

    expect(screen.queryByText("聚合")).not.toBeInTheDocument();
    expect(screen.queryByText(/default→/)).not.toBeInTheDocument();
  });
});

describe("ProviderList 计算聚合摘要", () => {
  it("按 AGGREGATE_TIERS 顺序拼接「档→供应商名」,名称取自 providers 表", () => {
    renderList({
      agg: aggregateProvider,
      pa: sourceProviderA,
      pb: sourceProviderB,
    });

    expect(screen.getByText("聚合")).toBeInTheDocument();
    expect(screen.getByText("default→A · opus→B")).toBeInTheDocument();
  });

  it("绑定来源不在 providers 表时回退为 providerId", () => {
    const ghostAggregate: Provider = {
      ...aggregateProvider,
      settingsConfig: {
        aggregate: { default: { providerId: "ghost-id", model: "x" } },
      },
    };
    renderList({ agg: ghostAggregate });

    expect(screen.getByText("default→ghost-id")).toBeInTheDocument();
  });

  it("普通供应商在列表中不展示「聚合」徽标与摘要", () => {
    renderList({ normal: normalProvider });

    expect(screen.queryByText("聚合")).not.toBeInTheDocument();
    expect(screen.queryByText(/default→/)).not.toBeInTheDocument();
  });
});
