/**
 * Workspace context for an agent pane.
 *
 * An agent tab normally lives in the agent's own workspace, so the pane's workspace and the
 * agent's agree. A collaboration worker keeps its own isolated worktree and may be opened as a
 * tab in the main conversation's workspace instead. Its diff, files and changes must still come
 * from the worker's own workspace — reading the pane's workspace there would show the main
 * checkout's context as if it belonged to the worker.
 */
export function resolveAgentPanelWorkspaceId(input: {
  paneWorkspaceId: string;
  agentWorkspaceId: string | null | undefined;
}): string {
  const agentWorkspaceId = input.agentWorkspaceId?.trim();
  return agentWorkspaceId && agentWorkspaceId !== input.paneWorkspaceId
    ? agentWorkspaceId
    : input.paneWorkspaceId;
}

/** Whether an agent pane shows an agent that belongs to a workspace other than its own. */
export function isAgentPaneCrossWorkspace(input: {
  paneWorkspaceId: string;
  agentWorkspaceId: string | null | undefined;
}): boolean {
  return resolveAgentPanelWorkspaceId(input) !== input.paneWorkspaceId;
}
