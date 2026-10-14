import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  manualSwitchTarget,
  openExecutionSwitch,
  type ExecutionSwitchRun,
} from "./execution-switch";

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "mock",
    status: "ready",
    enabled: true,
    label: "Mock",
    models: [
      {
        provider: "mock",
        id: "a",
        label: "A",
        isSelectable: true,
        thinkingOptions: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
      { provider: "mock", id: "b", label: "B", isSelectable: true },
    ],
  },
  {
    provider: "other",
    status: "ready",
    enabled: true,
    label: "Other",
    models: [{ provider: "other", id: "c", label: "C", isSelectable: true }],
  },
];

function blockedRun(overrides: Partial<ExecutionSwitchRun> = {}): ExecutionSwitchRun {
  return {
    id: "run-1",
    phase: "executing",
    control: "needs_attention",
    execution: {
      model: { provider: "mock/a" },
      relay: {
        status: "blocked",
        manual: true,
        errorClass: "quota",
        operationId: "op-1",
        token: 3,
        attempted: [{ provider: "mock/a" }],
        message: "usage limit reached",
      },
    },
    ...overrides,
  };
}

describe("manualSwitchTarget", () => {
  it("offers a manual quota block and a failed switch", () => {
    expect(manualSwitchTarget(blockedRun())?.expectedOperationId).toBe("op-1");
    const failed = blockedRun();
    failed.execution!.relay!.status = "failed";
    expect(manualSwitchTarget(failed)?.status).toBe("failed");
  });

  it("hides the action for other stages, automatic progress, and a stale notice", () => {
    expect(manualSwitchTarget(blockedRun({ control: "canceled" }))).toBeNull();
    expect(manualSwitchTarget(blockedRun({ phase: "completed" }))).toBeNull();
    expect(manualSwitchTarget(blockedRun({ phase: "awaiting_acceptance" }))).toBeNull();
    expect(manualSwitchTarget(blockedRun({ control: "running" }))).toBeNull();
    const preparing = blockedRun();
    preparing.execution!.relay = {
      ...preparing.execution!.relay!,
      status: "preparing",
      target: { provider: "mock/b" },
    };
    expect(manualSwitchTarget(preparing)).toBeNull();
    const automatic = blockedRun();
    automatic.execution!.relay!.manual = false;
    expect(manualSwitchTarget(automatic)).toBeNull();
    expect(manualSwitchTarget(blockedRun(), { operationId: "op-1", token: 2 })).toBeNull();
    expect(manualSwitchTarget(blockedRun(), { operationId: "older", token: 3 })).toBeNull();
    expect(manualSwitchTarget(undefined)).toBeNull();
  });
});

describe("openExecutionSwitch", () => {
  function model(createRequestId?: () => string) {
    const opened = openExecutionSwitch({
      requestId: "req-1",
      runId: "run-1",
      expectedOperationId: "op-1",
      token: 3,
      ...(createRequestId ? { createRequestId } : {}),
    });
    opened.applyProviders(entries);
    opened.applySupport(true);
    return opened;
  }

  it("stays disabled until a supported model is chosen", () => {
    const opened = model();
    expect(opened.getState().canSubmit).toBe(false);
    opened.selectProvider("mock", "Mock");
    opened.selectModel("b", "B");
    expect(opened.getState().canSubmit).toBe(true);
    opened.applySupport(false);
    expect(opened.getState().canSubmit).toBe(false);
    opened.applySupport(null);
    expect(opened.getState().canSubmit).toBe(false);
    opened.close();
  });

  it("holds a second submit while the first is pending and then shows success", async () => {
    const opened = model();
    opened.selectProvider("mock", "Mock");
    opened.selectModel("a", "A");
    opened.selectThinking("high", "High");
    let release: () => void = () => undefined;
    let calls = 0;
    const first = opened.submit(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          release = resolve;
        }),
    );
    expect(opened.getState().status).toBe("pending");
    expect(opened.getState().canSubmit).toBe(false);
    await opened.submit(async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    release();
    await first;
    expect(opened.getState().status).toBe("success");
    expect(opened.getState().succeededLabel).toBe("mock/a · High");
    opened.close();
  });

  it("shows the error and retries with the same request id", async () => {
    const opened = model();
    opened.selectProvider("mock", "Mock");
    opened.selectModel("b", "B");
    const sent: { requestId: string; provider: string }[] = [];
    const send = async (input: { requestId: string; model: { provider: string } }) => {
      sent.push({ requestId: input.requestId, provider: input.model.provider });
      if (sent.length === 1) throw new Error("任务已结束");
    };
    await opened.submit(send);
    expect(opened.getState().status).toBe("error");
    expect(opened.getState().error).toBe("任务已结束");
    expect(opened.getState().canSubmit).toBe(true);
    await opened.submit(send);
    expect(sent).toEqual([
      { requestId: "req-1", provider: "mock/b" },
      { requestId: "req-1", provider: "mock/b" },
    ]);
    expect(opened.getState().status).toBe("success");
    expect(opened.getState().succeededLabel).toBe("mock/b");
    opened.close();
  });

  it("keeps the initial id when the choice changes before the first submit", async () => {
    const opened = model();
    opened.selectProvider("mock", "Mock");
    opened.selectModel("b", "B");
    opened.selectModel("a", "A");
    opened.selectThinking("high", "High");
    const sent: string[] = [];
    await opened.submit(async (input) => {
      sent.push(input.requestId);
    });
    expect(sent).toEqual(["req-1"]);
    opened.close();
  });

  it("mints a request id when the provider, model, or thinking level changes", async () => {
    const minted = ["req-2", "req-3", "req-4"];
    const opened = model(() => {
      const id = minted.shift();
      if (!id) throw new Error("unexpected attempt");
      return id;
    });
    opened.selectProvider("mock", "Mock");
    opened.selectModel("a", "A");
    opened.selectThinking("high", "High");
    const sent: {
      requestId: string;
      provider: string;
      thinking?: string;
      token: number;
      expectedOperationId: string;
    }[] = [];
    const send = async (input: {
      requestId: string;
      token: number;
      expectedOperationId: string;
      model: { provider: string; thinkingOptionId?: string };
    }) => {
      sent.push({
        requestId: input.requestId,
        provider: input.model.provider,
        thinking: input.model.thinkingOptionId,
        token: input.token,
        expectedOperationId: input.expectedOperationId,
      });
      if (sent.length < 7)
        throw new Error("旧执行会话未能停止，未启动新模型；进度已保留，可稍后重试切换");
    };
    await opened.submit(send);
    await opened.submit(send);
    opened.selectThinking("low", "Low");
    await opened.submit(send);
    await opened.submit(send);
    opened.selectModel("b", "B");
    await opened.submit(send);
    opened.selectProvider("other", "Other");
    opened.selectModel("c", "C");
    await opened.submit(send);
    opened.selectProvider("mock", "Mock");
    opened.selectModel("a", "A");
    opened.selectThinking("high", "High");
    await opened.submit(send);
    expect(sent.map((item) => item.requestId)).toEqual([
      "req-1",
      "req-1",
      "req-2",
      "req-2",
      "req-3",
      "req-4",
      "req-1",
    ]);
    expect(sent.map((item) => item.provider)).toEqual([
      "mock/a",
      "mock/a",
      "mock/a",
      "mock/a",
      "mock/b",
      "other/c",
      "mock/a",
    ]);
    expect(sent.map((item) => item.thinking)).toEqual([
      "high",
      "high",
      "low",
      "low",
      undefined,
      undefined,
      "high",
    ]);
    expect(new Set(sent.map((item) => item.token))).toEqual(new Set([3]));
    expect(new Set(sent.map((item) => item.expectedOperationId))).toEqual(new Set(["op-1"]));
    expect(minted).toEqual([]);
    expect(opened.getState().status).toBe("success");
    opened.close();
  });
});
