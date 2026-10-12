import { describe, expect, it } from "vitest";
import { planSubagentOpen } from "@/subagents/open-subagent";

const SERVER_ID = "server-1";
const MAIN_WORKSPACE_ID = "ws-main";
const WORKER_WORKSPACE_ID = "ws-worker";
const MAIN_WORKSPACE_KEY = `${SERVER_ID}:${MAIN_WORKSPACE_ID}`;

describe("planSubagentOpen", () => {
  it("opens a subagent in the pane's workspace, never the subagent's own", () => {
    expect(
      planSubagentOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        subagentWorkspaceId: WORKER_WORKSPACE_ID,
        canSplit: true,
      }),
    ).toEqual({ kind: "preferred", workspaceKey: MAIN_WORKSPACE_KEY, pin: true });
  });

  it("pins a subagent from another workspace so reconcile keeps its tab", () => {
    expect(
      planSubagentOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        subagentWorkspaceId: WORKER_WORKSPACE_ID,
        canSplit: false,
      }),
    ).toEqual({ kind: "location", workspaceKey: MAIN_WORKSPACE_KEY, pin: true });
  });

  it("does not pin a subagent that belongs to the pane's workspace", () => {
    expect(
      planSubagentOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        subagentWorkspaceId: MAIN_WORKSPACE_ID,
        canSplit: true,
      }),
    ).toEqual({ kind: "preferred", workspaceKey: MAIN_WORKSPACE_KEY, pin: false });
  });

  it("does not pin a subagent whose workspace is not known yet", () => {
    expect(
      planSubagentOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        subagentWorkspaceId: null,
        canSplit: true,
      }),
    ).toEqual({ kind: "preferred", workspaceKey: MAIN_WORKSPACE_KEY, pin: false });
  });

  it("falls back to the pane when there is no workspace key", () => {
    expect(
      planSubagentOpen({
        serverId: "",
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        subagentWorkspaceId: WORKER_WORKSPACE_ID,
        canSplit: true,
      }),
    ).toEqual({ kind: "pane", pin: true });
  });
});
