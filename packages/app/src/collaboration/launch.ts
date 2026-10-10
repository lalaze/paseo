import { randomUUID } from "expo-crypto";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type {
  CollaborationIsolation,
  CollaborationMode,
  Settings,
} from "@getpaseo/protocol/collaboration/schema";
import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";
import type { LaunchLimits, LaunchSelections, ModelSelection } from "./launch-model";
import { useCollaborationLaunchStore } from "./launch-store";

export interface CollaborationTarget {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  /**
   * The composer's own agent/tab id, so the form's enable shares the pending flag and request id
   * the composer's send and one-tap path use. Absent for entries with no composer (palette).
   */
  keyAgentId?: string;
  goal?: string;
  requestId?: string;
  mode?: CollaborationMode;
  isolation?: CollaborationIsolation;
  selections?: LaunchSelections;
  limits?: LaunchLimits;
  settings?: Settings;
  /** Opens the mode dialog on the full form instead of the last-setup summary. */
  edit?: boolean;
  /** The conversation's live model, seeding the form when nothing is remembered. */
  currentModel?: ModelSelection | null;
}
/** Opens the dialog when no mode is chosen; otherwise enables and returns the host's fresh state. */
export async function enableCollaboration(
  target: CollaborationTarget,
): Promise<CollaborationState | undefined> {
  const requestId = target.requestId ?? randomUUID();
  if (!target.mode) {
    useCollaborationLaunchStore.setState({
      request: { ...target, requestId },
      configuring: false,
      originPath: null,
    });
    return undefined;
  }
  const client = getHostRuntimeStore().getClient(target.serverId);
  if (!client) throw new Error("Host disconnected");
  const features = client.getLastServerInfoMessage()?.features;
  if (target.mode === "execute_review" && !features?.collaborationExecuteReview)
    throw new Error("Update the host to use execution + review.");
  if (target.isolation === "worktree" && !features?.collaborationWorktree)
    throw new Error("Update the host to run collaboration in a separate worktree.");
  const state = await client.collaborationCommand("status");
  if (state.error) throw new Error(state.error);
  const opened = await client.collaborationCommand("conversation.open", {
    requestId,
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    goal: target.goal,
    fresh: !target.agentId,
    mode: target.mode,
    isolation: target.isolation,
    settings: target.settings,
  });
  const conversation = opened.conversations.find(
    (entry) =>
      entry.requestId === requestId || (target.agentId && entry.agentId === target.agentId),
  );
  if (!conversation?.agentId)
    throw new Error(
      conversation?.error ?? "The collaboration conversation is not ready. Retry to resume setup.",
    );
  if (target.agentId !== conversation.agentId)
    navigateToAgent({
      serverId: target.serverId,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
    });
  return opened;
}
