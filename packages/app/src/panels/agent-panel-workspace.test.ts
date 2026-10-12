import { describe, expect, it } from "vitest";
import {
  isAgentPaneCrossWorkspace,
  resolveAgentPanelWorkspaceId,
} from "@/panels/agent-panel-workspace";

describe("resolveAgentPanelWorkspaceId", () => {
  it("keeps the pane workspace when the agent belongs to it", () => {
    expect(
      resolveAgentPanelWorkspaceId({
        paneWorkspaceId: "workspace-main",
        agentWorkspaceId: "workspace-main",
      }),
    ).toBe("workspace-main");
  });

  it("uses the agent's own workspace when it differs from the pane", () => {
    expect(
      resolveAgentPanelWorkspaceId({
        paneWorkspaceId: "workspace-main",
        agentWorkspaceId: "workspace-worker",
      }),
    ).toBe("workspace-worker");
  });

  it("keeps the pane workspace while the agent's workspace is unknown", () => {
    expect(
      resolveAgentPanelWorkspaceId({ paneWorkspaceId: "workspace-main", agentWorkspaceId: null }),
    ).toBe("workspace-main");
    expect(
      resolveAgentPanelWorkspaceId({ paneWorkspaceId: "workspace-main", agentWorkspaceId: "  " }),
    ).toBe("workspace-main");
  });
});

describe("isAgentPaneCrossWorkspace", () => {
  it("is false for an agent in the pane's workspace", () => {
    expect(
      isAgentPaneCrossWorkspace({
        paneWorkspaceId: "workspace-main",
        agentWorkspaceId: "workspace-main",
      }),
    ).toBe(false);
  });

  it("is true for an agent in another workspace", () => {
    expect(
      isAgentPaneCrossWorkspace({
        paneWorkspaceId: "workspace-main",
        agentWorkspaceId: "workspace-worker",
      }),
    ).toBe(true);
  });
});
