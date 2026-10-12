import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * Where an agent's Changes view opens.
 *
 * The pane's workspace and the agent's workspace are usually the same, so the view opens in the
 * pane. A collaboration worker runs in its own worktree and can be shown as a tab in the main
 * workspace; its changes live in the worktree. A changes tab added to a workspace that is not on
 * screen is invisible, so the user is taken to the worker's workspace instead. Never opens the
 * pane workspace's diff for a worker — that would show the main checkout's changes.
 */
export type AgentChangesOpenPlan =
  | { kind: "navigate"; workspaceId: string }
  | { kind: "open"; workspaceKey: string };

export function planAgentChangesOpen(input: {
  serverId: string;
  /** The workspace the pane shows. */
  displayWorkspaceId: string;
  /** The workspace the agent runs in, where its changes actually are. */
  agentWorkspaceId: string;
  /**
   * The changes view would open as a pane/split tab, which stays invisible while another
   * workspace is on screen. The compact explorer is checkout-based and needs no navigation.
   */
  opensInPane: boolean;
}): AgentChangesOpenPlan | null {
  const agentWorkspaceId = input.agentWorkspaceId.trim();
  const displayWorkspaceId = input.displayWorkspaceId.trim();
  if (agentWorkspaceId && agentWorkspaceId !== displayWorkspaceId && input.opensInPane) {
    return { kind: "navigate", workspaceId: agentWorkspaceId };
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: agentWorkspaceId || displayWorkspaceId,
  });
  return workspaceKey ? { kind: "open", workspaceKey } : null;
}
