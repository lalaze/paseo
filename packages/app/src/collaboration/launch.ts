import { randomUUID } from "expo-crypto";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type {
  CollaborationIsolation,
  CollaborationMode,
  Settings,
} from "@getpaseo/protocol/collaboration/schema";
import type { LaunchSelections } from "./launch-model";
import { useCollaborationLaunchStore } from "./launch-store";

export interface CollaborationTarget {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  goal?: string;
  requestId?: string;
  mode?: CollaborationMode;
  isolation?: CollaborationIsolation;
  selections?: LaunchSelections;
  settings?: Settings;
}
export async function enableCollaboration(target: CollaborationTarget) {
  const requestId = target.requestId ?? randomUUID();
  if (!target.mode) {
    useCollaborationLaunchStore.setState({
      request: { ...target, requestId },
      configuring: false,
      originPath: null,
    });
    return;
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
}
