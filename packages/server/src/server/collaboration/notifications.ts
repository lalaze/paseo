import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { Conversation } from "@getpaseo/protocol/collaboration/conversation";
import type { Run } from "@getpaseo/protocol/collaboration/schema";

export function muteCollaborationNotification(input: {
  agentId: string;
  reason: string;
  timeline: AgentTimelineItem[];
  runs: Run[];
  conversations: Conversation[];
}): boolean {
  if (input.reason !== "finished") return false;
  const message = input.timeline.findLast((item) => item.type === "user_message");
  if (!message || message.type !== "user_message") return false;
  const id = message.clientMessageId ?? message.messageId;
  const conversation = input.conversations.find((entry) => entry.agentId === input.agentId);
  if (!conversation)
    return input.runs.some((run) =>
      run.operations.some(
        (operation) => operation.agentId === input.agentId && operation.id === id,
      ),
    );
  const run = input.runs.find((entry) => entry.id === conversation.runId);
  if (run?.operations.some((candidateOperation) => candidateOperation.id === id)) return true;
  const notice = conversation.notices.find((entry) => entry.id === id);
  if (notice && run)
    return (
      !conversation.confirmation &&
      ["planning", "executing", "reviewing", "final_review"].includes(run.phase) &&
      ["running", "paused"].includes(run.control)
    );
  return (
    conversation.takeover?.messages.some((entry) => entry.id === id && entry.automatic) ?? false
  );
}
