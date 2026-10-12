import { planAgentChangesOpen } from "@/workspace-tabs/open-agent-changes";

/**
 * Where a draft's review attachment opens.
 *
 * The draft's tab lives in the workspace on screen, but a `/clear` on a collaboration worker
 * creates an agent in the worker's own workspace. The review describes that checkout, so the
 * action must carry the runtime workspace's id and cwd — never the display workspace's. The
 * `checkoutCwd` on the open action is what the compact explorer uses; the desktop path ignores it
 * and navigates to the runtime workspace instead, because a diff tab added to a workspace that is
 * not on screen would be invisible.
 */
export type DraftReviewOpenAction =
  | { kind: "navigate"; workspaceId: string }
  | { kind: "open"; workspaceKey: string; checkoutCwd: string };

export function planDraftReviewOpen(input: {
  serverId: string;
  /** The workspace the draft tab is shown in. */
  displayWorkspaceId: string;
  /** The workspace the created agent will run in. Absent means the display workspace. */
  runtimeWorkspaceId?: string;
  /** The working directory of the agent the draft will create, i.e. its checkout. */
  cwd: string;
  /** The changes view would open as a pane/split tab, invisible while another workspace is shown. */
  opensInPane: boolean;
}): DraftReviewOpenAction | null {
  const runtimeWorkspaceId = input.runtimeWorkspaceId?.trim();
  const plan = planAgentChangesOpen({
    serverId: input.serverId,
    displayWorkspaceId: input.displayWorkspaceId,
    agentWorkspaceId: runtimeWorkspaceId || input.displayWorkspaceId,
    opensInPane: input.opensInPane,
  });
  if (!plan) {
    return null;
  }
  if (plan.kind === "navigate") {
    return { kind: "navigate", workspaceId: plan.workspaceId };
  }
  return { kind: "open", workspaceKey: plan.workspaceKey, checkoutCwd: input.cwd };
}
