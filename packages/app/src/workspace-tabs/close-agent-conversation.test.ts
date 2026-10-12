import { describe, expect, it } from "vitest";
import {
  closeAgentConversation,
  type CloseAgentConversationPorts,
} from "@/workspace-tabs/close-agent-conversation";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const SERVER_ID = "server-1";
const MAIN_WORKSPACE_ID = "ws-main";
const MAIN_WORKSPACE_KEY = `${SERVER_ID}:${MAIN_WORKSPACE_ID}`;
const TAB_ID = "agent_worker";
const AGENT_ID = "worker";

interface RecordedCall {
  port: string;
  workspaceKey?: string;
  agentId?: string;
  tabId?: string;
  target?: WorkspaceTabTarget;
}

function createRecordingPorts(): { calls: RecordedCall[]; ports: CloseAgentConversationPorts } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    ports: {
      unpinAgent: (workspaceKey, agentId) => calls.push({ port: "unpin", workspaceKey, agentId }),
      hideAgent: (workspaceKey, agentId) => calls.push({ port: "hide", workspaceKey, agentId }),
      closeTab: (workspaceKey, tabId) => calls.push({ port: "close", workspaceKey, tabId }),
      retargetCurrentTab: (target) => calls.push({ port: "retarget", target }),
    },
  };
}

describe("closeAgentConversation", () => {
  it("clears the tab lifecycle in the pane's workspace on exit", () => {
    const { calls, ports } = createRecordingPorts();

    closeAgentConversation(
      {
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentId: AGENT_ID,
        tabId: TAB_ID,
        nextTarget: null,
      },
      ports,
    );

    expect(calls).toEqual([
      { port: "unpin", workspaceKey: MAIN_WORKSPACE_KEY, agentId: AGENT_ID },
      { port: "hide", workspaceKey: MAIN_WORKSPACE_KEY, agentId: AGENT_ID },
      { port: "close", workspaceKey: MAIN_WORKSPACE_KEY, tabId: TAB_ID },
    ]);
  });

  it("retargets the pane's tab instead of closing it on clear", () => {
    const { calls, ports } = createRecordingPorts();
    const draftTarget: WorkspaceTabTarget = { kind: "draft", draftId: "draft-1" };

    closeAgentConversation(
      {
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentId: AGENT_ID,
        tabId: TAB_ID,
        nextTarget: draftTarget,
      },
      ports,
    );

    expect(calls).toEqual([
      { port: "unpin", workspaceKey: MAIN_WORKSPACE_KEY, agentId: AGENT_ID },
      { port: "hide", workspaceKey: MAIN_WORKSPACE_KEY, agentId: AGENT_ID },
      { port: "retarget", target: draftTarget },
    ]);
  });

  it("touches nothing when there is no workspace key", () => {
    const { calls, ports } = createRecordingPorts();

    closeAgentConversation(
      {
        serverId: "",
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        agentId: AGENT_ID,
        tabId: TAB_ID,
        nextTarget: null,
      },
      ports,
    );

    expect(calls).toEqual([]);
  });
});
