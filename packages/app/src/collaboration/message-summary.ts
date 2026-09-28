import { ENABLE_COLLABORATION_MESSAGE } from "@getpaseo/protocol/collaboration/conversation";
import {
  readCollaborationNotice,
  readCollaborationPrompt,
} from "@getpaseo/protocol/collaboration/presentation";
import type { UserMessageItem } from "@/types/stream";

export type CollaborationMessageStage =
  | "plan"
  | "execute"
  | "review"
  | "final"
  | "progress"
  | "approval"
  | "acceptance"
  | "enabled";

export interface CollaborationMessageSummary {
  stage: CollaborationMessageStage;
  /** Empty when the stage label says everything. */
  text: string;
  /** What the main Agent was told, without the scheduler marker or JSON context. */
  instructions: string;
  acceptance: string[];
}

const TAKEOVER_MARKER = "\n\n[paseo-director-takeover]\n";
const AUTOMATIC_COMMANDS = ["chat-command:native:", "chat-command:resync:"];

export function collaborationMessageSummary(
  item: Pick<UserMessageItem, "text" | "clientMessageId" | "messageId">,
): CollaborationMessageSummary | undefined {
  const id = item.clientMessageId ?? item.messageId;
  if (!id) return;
  const prompt = readCollaborationPrompt(item.text);
  if (prompt && prompt.operationId === id)
    return {
      stage: prompt.stage,
      text: prompt.task ?? prompt.goal,
      instructions: prompt.instruction,
      acceptance: prompt.acceptance,
    };
  if (id.startsWith("chat-notice:")) {
    const notice = readCollaborationNotice(id, item.text);
    if (!notice) return;
    let stage: CollaborationMessageStage = "progress";
    if (notice.confirmation === "plan") stage = "approval";
    if (notice.confirmation === "final") stage = "acceptance";
    return {
      stage,
      text: notice.message,
      instructions: joinParagraphs(notice.instruction, notice.reply),
      acceptance: [],
    };
  }
  const boundary = item.text.indexOf(TAKEOVER_MARKER);
  if (id.startsWith("chat-command:") && boundary > 0) {
    const text = item.text.slice(0, boundary);
    const instructions = item.text.slice(boundary + TAKEOVER_MARKER.length).trim();
    // Automatic commands are addressed to the Agent; the user did not type them.
    const automatic =
      text === ENABLE_COLLABORATION_MESSAGE ||
      AUTOMATIC_COMMANDS.some((prefix) => id.startsWith(prefix));
    return {
      stage: "enabled",
      text: automatic ? "" : text,
      instructions: automatic ? joinParagraphs(text, instructions) : instructions,
      acceptance: [],
    };
  }
}

function joinParagraphs(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join("\n\n");
}
