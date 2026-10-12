import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface CloseAgentConversationPorts {
  unpinAgent: (workspaceKey: string, agentId: string) => void;
  hideAgent: (workspaceKey: string, agentId: string) => void;
  closeTab: (workspaceKey: string, tabId: string) => void;
  /** Retargets the pane's current tab, which lives in the display workspace. */
  retargetCurrentTab: (target: WorkspaceTabTarget) => void;
}

/**
 * Tears down the conversation tab when the agent is archived (`/exit`) or replaced with a fresh
 * draft (`/clear`).
 *
 * Tab lifecycle belongs to the workspace the pane shows. The agent may run in another workspace —
 * a collaboration worker in its own worktree shown in the main conversation — and closing the
 * worker's own workspace tab instead of the one the user is looking at would leave the visible
 * pinned tab behind and unpin the wrong layout.
 */
export function closeAgentConversation(
  input: {
    serverId: string;
    /** The workspace the pane shows, which owns the tab. */
    displayWorkspaceId: string;
    agentId: string;
    tabId: string;
    /** A draft target to replace the tab with (`/clear`); null closes it (`/exit`). */
    nextTarget: WorkspaceTabTarget | null;
  },
  ports: CloseAgentConversationPorts,
): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.displayWorkspaceId,
  });
  if (workspaceKey) {
    ports.unpinAgent(workspaceKey, input.agentId);
    ports.hideAgent(workspaceKey, input.agentId);
  }
  if (input.nextTarget) {
    ports.retargetCurrentTab(input.nextTarget);
    return;
  }
  if (workspaceKey) {
    ports.closeTab(workspaceKey, input.tabId);
  }
}
