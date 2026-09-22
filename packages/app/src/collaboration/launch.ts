import { randomUUID } from "expo-crypto";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { router } from "expo-router";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface CollaborationTarget {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  goal?: string;
  requestId?: string;
}
const pending = new Map<string, string>();
export async function enableCollaboration(target: CollaborationTarget) {
  const key = JSON.stringify([target.serverId, target.workspaceId, target.agentId, target.goal]);
  const requestId = target.requestId ?? pending.get(key) ?? randomUUID();
  pending.set(key, requestId);
  const client = getHostRuntimeStore().getClient(target.serverId);
  if (!client) throw new Error("Host disconnected");
  const state = await client.collaborationCommand("status");
  if (state.error) throw new Error(state.error);
  if (!state.settings) {
    router.push({
      pathname: "/settings/hosts/[serverId]/[hostSection]",
      params: { ...target, requestId, hostSection: "collaboration" },
    });
    return;
  }
  const opened = await client.collaborationCommand("conversation.open", {
    requestId,
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    goal: target.goal,
    fresh: !target.agentId,
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
  navigateToAgent({
    serverId: target.serverId,
    workspaceId: conversation.workspaceId,
    agentId: conversation.agentId,
  });
}
