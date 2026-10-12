import { describe, expect, it } from "vitest";
import { planAgentChangesOpen } from "@/workspace-tabs/open-agent-changes";

const SERVER_ID = "server-1";
const MAIN_WORKSPACE_ID = "ws-main";
const WORKER_WORKSPACE_ID = "ws-worker";
const MAIN_WORKSPACE_KEY = `${SERVER_ID}:${MAIN_WORKSPACE_ID}`;
const WORKER_WORKSPACE_KEY = `${SERVER_ID}:${WORKER_WORKSPACE_ID}`;

describe("planAgentChangesOpen", () => {
  it("opens changes in the pane when the agent runs in the pane's workspace", () => {
    expect(
      planAgentChangesOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentWorkspaceId: MAIN_WORKSPACE_ID,
        opensInPane: true,
      }),
    ).toEqual({ kind: "open", workspaceKey: MAIN_WORKSPACE_KEY });
  });

  it("navigates to the agent's workspace when its changes would open in a hidden pane", () => {
    expect(
      planAgentChangesOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentWorkspaceId: WORKER_WORKSPACE_ID,
        opensInPane: true,
      }),
    ).toEqual({ kind: "navigate", workspaceId: WORKER_WORKSPACE_ID });
  });

  it("keeps the checkout-based compact view pointed at the agent's workspace", () => {
    expect(
      planAgentChangesOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentWorkspaceId: WORKER_WORKSPACE_ID,
        opensInPane: false,
      }),
    ).toEqual({ kind: "open", workspaceKey: WORKER_WORKSPACE_KEY });
  });

  it("never opens the pane workspace's changes for an agent from another workspace", () => {
    const plan = planAgentChangesOpen({
      serverId: SERVER_ID,
      displayWorkspaceId: MAIN_WORKSPACE_ID,
      agentWorkspaceId: WORKER_WORKSPACE_ID,
      opensInPane: true,
    });
    expect(plan).not.toEqual({ kind: "open", workspaceKey: MAIN_WORKSPACE_KEY });
  });

  it("falls back to the pane workspace when the agent's workspace is unknown", () => {
    expect(
      planAgentChangesOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentWorkspaceId: "  ",
        opensInPane: true,
      }),
    ).toEqual({ kind: "open", workspaceKey: MAIN_WORKSPACE_KEY });
  });

  it("returns null when there is no workspace key", () => {
    expect(
      planAgentChangesOpen({
        serverId: "",
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentWorkspaceId: MAIN_WORKSPACE_ID,
        opensInPane: true,
      }),
    ).toBeNull();
  });
});
