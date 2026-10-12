import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * Where a subagent tab opens and whether it needs the explicit-open pin.
 *
 * A subagent tab always belongs to the workspace the pane is showing, never to the subagent's
 * own workspace: a collaboration worker runs in an isolated worktree, and opening it must not
 * move the user out of the conversation they are reading.
 *
 * `pin` only matters for a subagent from another workspace. Workspace reconcile prunes agent tabs
 * whose agent is not active in that workspace, and a cross-workspace worker is never active in
 * the pane's workspace, so its tab would close on the next reconcile without the pin an explicit
 * deep-link open uses.
 */
export type SubagentOpenPlan =
  | { kind: "preferred"; workspaceKey: string; pin: boolean }
  | { kind: "location"; workspaceKey: string; pin: boolean }
  | { kind: "pane"; pin: boolean };

export function planSubagentOpen(input: {
  serverId: string;
  /** The workspace the pane shows. The tab always opens here. */
  displayWorkspaceId: string;
  /** The subagent's own workspace. Only decides whether the tab needs the explicit-open pin. */
  subagentWorkspaceId: string | null | undefined;
  /** The pane can host a side pane, so the user's side-pane preference applies. */
  canSplit: boolean;
}): SubagentOpenPlan {
  const displayWorkspaceId = input.displayWorkspaceId.trim();
  const subagentWorkspaceId = input.subagentWorkspaceId?.trim();
  const pin = Boolean(subagentWorkspaceId && subagentWorkspaceId !== displayWorkspaceId);
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: displayWorkspaceId,
  });
  if (!workspaceKey) {
    return { kind: "pane", pin };
  }
  return input.canSplit
    ? { kind: "preferred", workspaceKey, pin }
    : { kind: "location", workspaceKey, pin };
}
