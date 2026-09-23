import { randomUUID } from "expo-crypto";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { CollaborationMode } from "@getpaseo/protocol/collaboration/schema";
import { useCollaborationLaunchStore } from "./launch-store";

export interface CollaborationTarget {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  goal?: string;
  requestId?: string;
  mode?: CollaborationMode;
}
const pending = new Map<string, string>();
export async function enableCollaboration(target: CollaborationTarget) {
  const key = JSON.stringify([target.serverId, target.workspaceId, target.agentId, target.goal]);
  const requestId = target.requestId ?? pending.get(key) ?? randomUUID();
  pending.set(key, requestId);
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
  if (
    target.mode === "execute_review" &&
    !client.getLastServerInfoMessage()?.features?.collaborationExecuteReview
  )
    throw new Error("Update the host to use execution + review.");
  const state = await client.collaborationCommand("status");
  if (state.error) throw new Error(state.error);
  if (!state.settings) throw new Error("Save collaboration settings before continuing.");
  const opened = await client.collaborationCommand("conversation.open", {
    requestId,
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    goal: target.goal,
    fresh: !target.agentId,
    mode: target.mode,
  });
  const conversation = opened.conversations.find(
    (entry) =>
      entry.requestId === requestId || (target.agentId && entry.agentId === target.agentId),
  );
  if (!conversation?.agentId)
    throw new Error(
      conversation?.error ?? "The collaboration conversation is not ready. Retry to resume setup.",
    );
  pending.delete(key);
  if (target.agentId !== conversation.agentId)
    navigateToAgent({
      serverId: target.serverId,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
    });
}
