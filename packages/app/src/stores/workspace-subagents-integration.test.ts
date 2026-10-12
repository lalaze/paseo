import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceTabSnapshot,
  deriveWorkspaceAgentVisibility,
  type WorkspaceAgentVisibility,
} from "@/workspace-tabs/agent-visibility";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { planSubagentOpen } from "@/subagents/open-subagent";
import { closeAgentConversation } from "@/workspace-tabs/close-agent-conversation";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { selectSubagentsForParent } from "@/subagents/select";
import { findPaneById, findPaneContainingTab } from "./workspace-layout-actions";
import { useWorkspaceLayoutStore } from "./workspace-layout-store";
import { useSessionStore, type Agent } from "./session-store";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";
const WORKER_WORKSPACE_ID = "ws-worker";
const WORKSPACE_DIRECTORY = "/repo/worktree";
const WORKER_DIRECTORY = "/repo/worker-worktree";
const MAIN_WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;
const WORKER_WORKSPACE_KEY = `${SERVER_ID}:${WORKER_WORKSPACE_ID}`;

const OPEN_IN_MAIN_PANE = {
  explorerFiles: false,
  diffs: false,
  chatFiles: false,
  diffFiles: false,
  subagents: false,
};

const AGENT_TIMESTAMP = new Date("2026-04-21T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: WORKSPACE_DIRECTORY,
  workspaceId: WORKSPACE_ID,
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function initializeAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

function appendAgent(agent: Agent): void {
  useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
    const nextAgents = new Map(agents);
    nextAgents.set(agent.id, agent);
    return nextAgents;
  });
}

function deriveVisibilityFromSession(): WorkspaceAgentVisibility {
  const sessionAgents = useSessionStore.getState().sessions[SERVER_ID]?.agents ?? new Map();
  return deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceId: WORKSPACE_ID,
  });
}

function reconcileWorkspaceTabs(workspaceKey: string, visibility: WorkspaceAgentVisibility): void {
  useWorkspaceLayoutStore.getState().reconcileTabs(
    workspaceKey,
    buildWorkspaceTabSnapshot({
      agentVisibility: visibility,
      agentsHydrated: true,
      terminalsHydrated: true,
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    }),
  );
}

function getWorkspaceAgentTabIds(workspaceKey: string): string[] {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .filter((tab) => tab.target.kind === "agent")
    .map((tab) => tab.tabId);
}

function deriveVisibilityFor(workspaceId: string): WorkspaceAgentVisibility {
  const sessionAgents = useSessionStore.getState().sessions[SERVER_ID]?.agents ?? new Map();
  return deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId });
}

function reconcileFor(workspaceKey: string, workspaceId: string): void {
  useWorkspaceLayoutStore.getState().reconcileTabs(
    workspaceKey,
    buildWorkspaceTabSnapshot({
      agentVisibility: deriveVisibilityFor(workspaceId),
      agentsHydrated: true,
      terminalsHydrated: true,
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    }),
  );
}

/**
 * Opens a subagent the way the track does: the plan decides the workspace and pin, and the real
 * layout adapter opens the tab.
 */
function openSubagentTab(input: {
  displayWorkspaceId: string;
  subagentWorkspaceId: string | null;
  subagentId: string;
  parentTabId?: string;
}): string | null {
  const plan = planSubagentOpen({
    serverId: SERVER_ID,
    displayWorkspaceId: input.displayWorkspaceId,
    subagentWorkspaceId: input.subagentWorkspaceId,
    canSplit: true,
  });
  if (plan.kind !== "preferred") {
    throw new Error(`Expected a preferred open, got ${plan.kind}`);
  }
  return openPreferredWorkspaceTarget({
    isCompact: false,
    workspaceKey: plan.workspaceKey,
    target: { kind: "agent", agentId: input.subagentId },
    source: "subagents",
    preferences: OPEN_IN_MAIN_PANE,
    parentTabId: input.parentTabId,
    pin: plan.pin,
  });
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
  });
});

describe("workspace subagents integration", () => {
  it("keeps a child ingested before its parent out of auto-tabs, then exposes it in the parent section", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const child = makeAgent({
      id: "child-agent",
      parentAgentId: "parent-agent",
      title: "Child agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      title: "Parent agent",
    });

    initializeAgents([child]);

    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceAgentTabIds(workspaceKey!)).toEqual([]);

    appendAgent(parent);

    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceAgentTabIds(workspaceKey!)).toEqual(["agent_parent-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-agent",
        },
        new Set(),
      ).map((row) => row.id),
    ).toEqual(["child-agent"]);
  });

  it("moves a detached child out of the parent section and back into normal workspace tabs", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const parent = makeAgent({
      id: "parent-agent",
      title: "Parent agent",
    });
    const child = makeAgent({
      id: "child-agent",
      parentAgentId: "parent-agent",
      title: "Child agent",
    });

    initializeAgents([parent, child]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceAgentTabIds(workspaceKey!)).toEqual(["agent_parent-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-agent",
        },
        new Set(),
      ).map((row) => row.id),
    ).toEqual(["child-agent"]);

    appendAgent({ ...child, parentAgentId: null, labels: {} });
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceAgentTabIds(workspaceKey!)).toEqual([
      "agent_parent-agent",
      "agent_child-agent",
    ]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-agent",
        },
        new Set(),
      ),
    ).toEqual([]);
  });

  it("auto-opens a cross-workspace child while retaining it in the parent section", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const parent = makeAgent({
      id: "parent-agent",
      workspaceId: "ws-parent",
      title: "Parent agent",
    });
    const child = makeAgent({
      id: "child-agent",
      parentAgentId: parent.id,
      title: "Cross-workspace child",
    });

    initializeAgents([parent, child]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceAgentTabIds(workspaceKey!)).toEqual(["agent_child-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: parent.id,
        },
        new Set(),
      ).map((row) => row.id),
    ).toEqual([child.id]);
  });

  it("opens a cross-workspace worker in the parent workspace, reuses its tab, and keeps it pinned", () => {
    const parent = makeAgent({ id: "parent-agent", title: "Parent agent" });
    const worker = makeAgent({
      id: "worker-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      parentAgentId: parent.id,
      title: "Worker agent",
    });

    initializeAgents([parent, worker]);
    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual(["agent_parent-agent"]);

    const tabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: worker.id,
      parentTabId: "agent_parent-agent",
    });
    expect(tabId).toBe("agent_worker-agent");
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual([
      "agent_parent-agent",
      "agent_worker-agent",
    ]);

    const reopenedTabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: worker.id,
      parentTabId: "agent_parent-agent",
    });
    expect(reopenedTabId).toBe(tabId);
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual([
      "agent_parent-agent",
      "agent_worker-agent",
    ]);

    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toContain("agent_worker-agent");
  });

  it("opens a worker's managed child in the main workspace without touching the worker's layout", () => {
    const parent = makeAgent({ id: "parent-agent", title: "Parent agent" });
    const worker = makeAgent({
      id: "worker-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      parentAgentId: parent.id,
      title: "Worker agent",
    });
    const child = makeAgent({
      id: "child-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      parentAgentId: worker.id,
      title: "Child agent",
    });

    initializeAgents([parent, worker, child]);
    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);
    reconcileFor(WORKER_WORKSPACE_KEY, WORKER_WORKSPACE_ID);
    expect(getWorkspaceAgentTabIds(WORKER_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);

    const mainTabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: worker.id,
      parentTabId: "agent_parent-agent",
    });
    const childTabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: child.id,
      parentTabId: mainTabId ?? undefined,
    });

    expect(childTabId).toBe("agent_child-agent");
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual([
      "agent_parent-agent",
      "agent_worker-agent",
      "agent_child-agent",
    ]);
    expect(getWorkspaceAgentTabIds(WORKER_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);

    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toContain("agent_child-agent");
  });

  it("opens a worker's provider subagent in the main workspace, not the worker's layout", () => {
    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);

    const tabId = openPreferredWorkspaceTarget({
      isCompact: false,
      workspaceKey: MAIN_WORKSPACE_KEY,
      target: { kind: "provider_subagent", parentAgentId: "worker-agent", subagentId: "task-1" },
      source: "subagents",
      preferences: OPEN_IN_MAIN_PANE,
    });

    expect(tabId).toBeTruthy();
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(MAIN_WORKSPACE_KEY)
        .some((tab) => tab.target.kind === "provider_subagent"),
    ).toBe(true);
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(WORKER_WORKSPACE_KEY)
        .some((tab) => tab.target.kind === "provider_subagent"),
    ).toBe(false);
  });

  it("clears only the pane workspace tab and pin when a cross-workspace worker exits", () => {
    const worker = makeAgent({
      id: "worker-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      title: "Worker agent",
    });

    initializeAgents([worker]);
    reconcileFor(WORKER_WORKSPACE_KEY, WORKER_WORKSPACE_ID);
    const mainTabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: worker.id,
    });
    expect(mainTabId).toBeTruthy();
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);
    expect(getWorkspaceAgentTabIds(WORKER_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);
    expect(
      useWorkspaceLayoutStore
        .getState()
        .pinnedAgentIdsByWorkspace[MAIN_WORKSPACE_KEY]?.has(worker.id),
    ).toBe(true);

    const retarget = vi.fn();
    const store = useWorkspaceLayoutStore.getState();
    closeAgentConversation(
      {
        serverId: SERVER_ID,
        displayWorkspaceId: WORKSPACE_ID,
        agentId: worker.id,
        tabId: mainTabId!,
        nextTarget: null,
      },
      {
        unpinAgent: store.unpinAgent,
        hideAgent: store.hideAgent,
        closeTab: store.closeTab,
        retargetCurrentTab: retarget,
      },
    );

    expect(retarget).not.toHaveBeenCalled();
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual([]);
    expect(
      useWorkspaceLayoutStore
        .getState()
        .pinnedAgentIdsByWorkspace[MAIN_WORKSPACE_KEY]?.has(worker.id),
    ).toBeFalsy();
    expect(getWorkspaceAgentTabIds(WORKER_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);
  });

  it("retargets the pane tab instead of closing it when a cross-workspace worker clears", () => {
    const worker = makeAgent({
      id: "worker-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      title: "Worker agent",
    });

    initializeAgents([worker]);
    reconcileFor(WORKER_WORKSPACE_KEY, WORKER_WORKSPACE_ID);
    const mainTabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: worker.id,
    });

    const retarget = vi.fn();
    const store = useWorkspaceLayoutStore.getState();
    closeAgentConversation(
      {
        serverId: SERVER_ID,
        displayWorkspaceId: WORKSPACE_ID,
        agentId: worker.id,
        tabId: mainTabId!,
        nextTarget: { kind: "draft", draftId: "draft-1" },
      },
      {
        unpinAgent: store.unpinAgent,
        hideAgent: store.hideAgent,
        closeTab: store.closeTab,
        retargetCurrentTab: retarget,
      },
    );

    expect(retarget).toHaveBeenCalledWith({ kind: "draft", draftId: "draft-1" });
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);
    expect(getWorkspaceAgentTabIds(WORKER_WORKSPACE_KEY)).toEqual(["agent_worker-agent"]);
  });

  it("carries a /clear replacement into the worker's workspace and keeps its pane tab", () => {
    const worker = makeAgent({
      id: "worker-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      title: "Worker agent",
    });

    initializeAgents([worker]);
    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);
    const mainTabId = openSubagentTab({
      displayWorkspaceId: WORKSPACE_ID,
      subagentWorkspaceId: WORKER_WORKSPACE_ID,
      subagentId: worker.id,
    });
    expect(mainTabId).toBeTruthy();

    // `/clear`: the pane tab becomes a draft that carries the worker's own workspace, so the
    // replacement agent is created in the worker's worktree instead of the pane's checkout.
    const store = useWorkspaceLayoutStore.getState();
    const draftTarget: WorkspaceTabTarget = {
      kind: "draft",
      draftId: "draft-1",
      setup: {
        provider: "codex",
        cwd: WORKER_DIRECTORY,
        workspaceId: WORKER_WORKSPACE_ID,
        modeId: null,
        model: null,
        thinkingOptionId: null,
        featureValues: {},
      },
    };
    closeAgentConversation(
      {
        serverId: SERVER_ID,
        displayWorkspaceId: WORKSPACE_ID,
        agentId: worker.id,
        tabId: mainTabId!,
        nextTarget: draftTarget,
      },
      {
        unpinAgent: store.unpinAgent,
        hideAgent: store.hideAgent,
        closeTab: store.closeTab,
        retargetCurrentTab: (target) => {
          store.replaceTab(MAIN_WORKSPACE_KEY, mainTabId!, target);
        },
      },
    );
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(MAIN_WORKSPACE_KEY)
        .some((tab) => tab.target.kind === "draft"),
    ).toBe(true);

    // The draft is submitted: the replacement agent runs in the worker's workspace, and the pane
    // pins it so reconcile keeps the conversation in the workspace the user is reading.
    const replacement = makeAgent({
      id: "replacement-agent",
      workspaceId: WORKER_WORKSPACE_ID,
      title: "Replacement",
    });
    appendAgent(replacement);
    const layout = useWorkspaceLayoutStore.getState();
    layout.replaceTab(MAIN_WORKSPACE_KEY, mainTabId!, {
      kind: "agent",
      agentId: replacement.id,
    });
    layout.pinAgent(MAIN_WORKSPACE_KEY, replacement.id);

    reconcileFor(MAIN_WORKSPACE_KEY, WORKSPACE_ID);
    expect(getWorkspaceAgentTabIds(MAIN_WORKSPACE_KEY)).toContain("agent_replacement-agent");
    expect(getWorkspaceAgentTabIds(WORKER_WORKSPACE_KEY)).toEqual([]);
  });

  it("opens a subagent in Explorer when Explorer is preferred", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const parent = makeAgent({
      id: "parent-agent",
      title: "Parent agent",
    });
    const child = makeAgent({
      id: "child-agent",
      parentAgentId: parent.id,
      title: "Child agent",
    });

    initializeAgents([parent, child]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.showExplorerSidebar(workspaceKey!) as string;
    const tabId = store.openTab({
      workspaceKey: workspaceKey!,
      target: { kind: "agent", agentId: child.id },
      intent: "reveal",
      parentTabId: `agent_${parent.id}`,
      placement: { mode: "prefer", paneId },
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey!];
    const explorerSidebarPaneId = state.explorerSidebarPaneIdByWorkspace[workspaceKey!];

    expect(explorerSidebarPaneId).toBeTruthy();
    expect(findPaneContainingTab(layout.root, tabId!)?.id).toBe(explorerSidebarPaneId);
    expect(findPaneById(layout.root, explorerSidebarPaneId!)?.hidden).toBeUndefined();
    expect(layout.focusedPaneId).toBe("main");
  });

  it("opens a provider subagent in Explorer when Explorer is preferred", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.showExplorerSidebar(workspaceKey!) as string;
    const tabId = store.openTab({
      workspaceKey: workspaceKey!,
      target: { kind: "provider_subagent", parentAgentId: "parent-agent", subagentId: "task-1" },
      intent: "reveal",
      parentTabId: "agent_parent-agent",
      placement: { mode: "prefer", paneId },
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey!];
    const explorerSidebarPaneId = state.explorerSidebarPaneIdByWorkspace[workspaceKey!];

    expect(explorerSidebarPaneId).toBeTruthy();
    expect(findPaneContainingTab(layout.root, tabId!)?.id).toBe(explorerSidebarPaneId);
    expect(findPaneById(layout.root, explorerSidebarPaneId!)?.hidden).toBeUndefined();
    expect(layout.focusedPaneId).toBe("main");
  });
});
