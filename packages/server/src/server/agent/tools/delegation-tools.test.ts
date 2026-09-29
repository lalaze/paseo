import { describe, expect, it } from "vitest";
import {
  DELEGATION_CANCELED_AT_LABEL,
  canDelegateAtDepth,
  delegatedTaskTitle,
  projectDelegatedTask,
  registerDelegationTools,
  resolveDelegationDepth,
  type DelegatedAgentView,
  type DelegationToolsOptions,
} from "./delegation-tools.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

const PARENT = "paseo.parent-agent-id";

function agent(overrides: Partial<DelegatedAgentView> & { id: string }): DelegatedAgentView {
  return {
    provider: "codex",
    lifecycle: "idle",
    labels: {},
    lastUserMessageAt: null,
    pendingPermissions: new Map(),
    ...overrides,
  };
}

type Handler = (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;

function setup(overrides: Partial<DelegationToolsOptions> = {}) {
  const agents = new Map<string, DelegatedAgentView>([["main", agent({ id: "main" })]]);
  const tools = new Map<string, Handler>();
  const created: Parameters<DelegationToolsOptions["createChild"]>[0][] = [];
  let nextId = 1;
  registerDelegationTools({
    callerAgentId: "main",
    registerTool: (name, _config, handler) => tools.set(name, handler as Handler),
    readConfig: () => ({ enabled: true, depthLimit: 1, agentDefaults: {} }),
    listProviders: () => ["claude", "codex"],
    getAgent: (id) => agents.get(id) ?? null,
    getLastAssistantMessage: async (id) => `result of ${id}`,
    createChild: async (input) => {
      created.push(input);
      const id = `child-${nextId++}`;
      agents.set(
        id,
        agent({ id, provider: input.provider, lifecycle: "running", labels: { [PARENT]: "main" } }),
      );
      return { agentId: id };
    },
    cancelRun: async (id) => {
      const current = agents.get(id);
      if (current) agents.set(id, { ...current, lifecycle: "idle" });
    },
    setLabels: async (id, labels) => {
      const current = agents.get(id);
      if (current) agents.set(id, { ...current, labels: { ...current.labels, ...labels } });
    },
    ...overrides,
  });
  const call = async (name: string, input: unknown) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`tool ${name} not registered`);
    return (await handler(input, {})).structuredContent as Record<string, unknown>;
  };
  return { agents, tools, created, call };
}

describe("projectDelegatedTask", () => {
  it("hides agents that are not the caller's children", () => {
    expect(projectDelegatedTask("x", agent({ id: "x" }), "main")).toEqual({
      taskId: "x",
      status: "unknown",
    });
    expect(projectDelegatedTask("x", null, "main").status).toBe("unknown");
  });

  it("reports a pending permission as blocked while running", () => {
    const child = agent({
      id: "c",
      lifecycle: "running",
      labels: { [PARENT]: "main" },
      pendingPermissions: new Map([["p1", { id: "p1", name: "Bash", title: "Run tests" }]]),
    });
    expect(projectDelegatedTask("c", child, "main")).toMatchObject({
      status: "running",
      blockedOn: { kind: "permission", id: "p1", title: "Run tests" },
    });
  });

  it("stops reporting canceled once a newer prompt arrives", () => {
    const labels = { [PARENT]: "main", [DELEGATION_CANCELED_AT_LABEL]: "2026-01-01T00:00:00Z" };
    expect(projectDelegatedTask("c", agent({ id: "c", labels }), "main").status).toBe("canceled");
    const followedUp = agent({
      id: "c",
      labels,
      lastUserMessageAt: new Date("2026-01-01T00:01:00Z"),
    });
    expect(projectDelegatedTask("c", followedUp, "main").status).toBe("completed");
  });

  it("maps an errored child to failed with its error", () => {
    const child = agent({
      id: "c",
      lifecycle: "error",
      lastError: "quota",
      labels: { [PARENT]: "main" },
    });
    expect(projectDelegatedTask("c", child, "main")).toMatchObject({
      status: "failed",
      error: "quota",
    });
  });
});

describe("delegation depth", () => {
  it("counts delegating ancestors", () => {
    const agents: Record<string, { labels: Record<string, string> }> = {
      root: { labels: {} },
      a: { labels: { [PARENT]: "root" } },
      b: { labels: { [PARENT]: "a" } },
    };
    expect(resolveDelegationDepth("root", (id) => agents[id])).toBe(0);
    expect(resolveDelegationDepth("b", (id) => agents[id])).toBe(2);
  });

  it("allows only root agents to delegate at the default limit", () => {
    const config = { enabled: true, depthLimit: 1, agentDefaults: {} };
    expect(canDelegateAtDepth(config, 0)).toBe(true);
    expect(canDelegateAtDepth(config, 1)).toBe(false);
    expect(canDelegateAtDepth({ ...config, enabled: false }, 0)).toBe(false);
  });
});

describe("registerDelegationTools", () => {
  it("registers nothing when delegation is off", () => {
    const { tools } = setup({
      readConfig: () => ({ enabled: false, depthLimit: 1, agentDefaults: {} }),
    });
    expect(tools.size).toBe(0);
  });

  it("delegates with the configured per-agent defaults", async () => {
    const { call, created } = setup({
      readConfig: () => ({
        enabled: true,
        depthLimit: 1,
        agentDefaults: { claude: { model: "sonnet", modeId: "acceptEdits" } },
      }),
    });
    const result = await call("delegate_to_agent", { agent: "claude", task: "Review the diff" });
    expect(result).toMatchObject({ taskId: "child-1", agent: "claude", status: "running" });
    expect(created[0]).toMatchObject({
      provider: "claude",
      model: "sonnet",
      modeId: "acceptEdits",
      task: "Review the diff",
    });
  });

  it("returns a finished task's result from a wait", async () => {
    const { call, agents } = setup();
    await call("delegate_to_agent", { agent: "codex", task: "Fix it" });
    const child = agents.get("child-1")!;
    setTimeout(() => agents.set("child-1", { ...child, lifecycle: "idle" }), 20);
    const result = await call("get_delegation_status", { taskIds: ["child-1"], waitMs: 5_000 });
    expect(result.tasks).toEqual([
      { taskId: "child-1", agent: "codex", status: "completed", result: "result of child-1" },
    ]);
  });

  it("wakes a wait once per permission prompt", async () => {
    const { call, agents } = setup();
    await call("delegate_to_agent", { agent: "codex", task: "Fix it" });
    const child = agents.get("child-1")!;
    agents.set("child-1", {
      ...child,
      pendingPermissions: new Map([["p1", { id: "p1", name: "Bash" }]]),
    });
    const first = await call("get_delegation_status", { taskIds: ["child-1"], waitMs: 5_000 });
    expect(first.tasks).toMatchObject([{ status: "running", blockedOn: { id: "p1" } }]);
    const startedAt = Date.now();
    await call("get_delegation_status", { taskIds: ["child-1"], waitMs: 600 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
  });

  it("cancels a running task and keeps a finished one", async () => {
    const { call, agents } = setup();
    await call("delegate_to_agent", { agent: "codex", task: "One" });
    await call("delegate_to_agent", { agent: "codex", task: "Two" });
    agents.set("child-2", { ...agents.get("child-2")!, lifecycle: "idle" });

    expect(await call("cancel_delegation", { taskId: "child-1" })).toMatchObject({
      task: { taskId: "child-1", status: "canceled" },
    });
    expect(await call("cancel_delegation", { taskId: "child-2" })).toMatchObject({
      task: { taskId: "child-2", status: "completed", result: "result of child-2" },
    });
    await expect(call("cancel_delegation", { taskId: "main" })).rejects.toThrow("Unknown");
  });
});

describe("delegatedTaskTitle", () => {
  it("uses the first line, shortened", () => {
    expect(delegatedTaskTitle("  Fix login\nmore detail")).toBe("Fix login");
    expect(delegatedTaskTitle("x".repeat(80))).toHaveLength(60);
  });
});
