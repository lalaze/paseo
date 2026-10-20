import { z } from "zod";
import { ENABLE_COLLABORATION_MESSAGE } from "@getpaseo/protocol/collaboration/conversation";
import {
  readCollaborationNotice,
  readCollaborationPrompt,
  type AcceptanceReport,
  type ReviewProgress,
} from "@getpaseo/protocol/collaboration/presentation";
import type { UserMessageItem } from "@/types/stream";
import { ExecutionModelSchema, type Plan } from "@getpaseo/protocol/collaboration/schema";

export type CollaborationMessageStage =
  | "plan"
  | "execute"
  | "review"
  | "final"
  | "progress"
  | "approval"
  | "acceptance"
  | "enabled";

const NoticeExecutionSchema = z.object({
  profileId: z.string(),
  model: ExecutionModelSchema.optional(),
  relay: z
    .object({
      status: z.enum(["blocked", "stopping", "preparing", "failed"]),
      source: z.enum(["automatic", "manual", "none"]),
      operationId: z.string(),
      token: z.number(),
      manual: z.boolean(),
      message: z.string(),
      target: ExecutionModelSchema.optional(),
      reason: z.string().optional(),
    })
    .optional(),
});
export type CollaborationNoticeExecution = z.infer<typeof NoticeExecutionSchema>;

export interface CollaborationMessageSummary {
  stage: CollaborationMessageStage;
  phase?: string;
  control?: string;
  /** Empty when the stage label says everything. */
  text: string;
  /** What the main Agent was told, without the scheduler marker or JSON context. */
  instructions: string;
  acceptance: string[];
  plan?: Plan;
  acceptanceReport?: AcceptanceReport;
  reviewProgress?: ReviewProgress;
  /** Quota handoff carried by this notice. Absent on older notices. */
  execution?: CollaborationNoticeExecution;
}

/** Read execution from a notice without dropping the notice when the field is absent or malformed. */
export function readNoticeExecution(raw: string): CollaborationNoticeExecution | undefined {
  const start = raw.indexOf("\n{");
  if (start < 0) return;
  try {
    const body = JSON.parse(raw.slice(start + 1)) as { execution?: unknown };
    if (body.execution === undefined) return;
    const parsed = NoticeExecutionSchema.safeParse(body.execution);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
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
  if (id.startsWith("chat-notice:")) return noticeSummary(id, item.text);
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

function noticeSummary(id: string, text: string): CollaborationMessageSummary | undefined {
  const notice = readCollaborationNotice(id, text);
  if (!notice) return;
  let stage = noticeStage(notice.phase);
  if (notice.confirmation === "plan") stage = "approval";
  if (notice.confirmation === "final") stage = "acceptance";
  const execution = readNoticeExecution(text);
  return {
    stage,
    text: notice.message,
    instructions: joinParagraphs(notice.instruction, notice.reply),
    acceptance: [],
    ...(notice.phase ? { phase: notice.phase } : {}),
    ...(notice.control ? { control: notice.control } : {}),
    ...(notice.plan ? { plan: notice.plan } : {}),
    ...(notice.acceptanceReport ? { acceptanceReport: notice.acceptanceReport } : {}),
    ...(notice.reviewProgress ? { reviewProgress: notice.reviewProgress } : {}),
    ...(execution ? { execution } : {}),
  };
}

function joinParagraphs(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join("\n\n");
}

function noticeStage(phase?: string): CollaborationMessageStage {
  switch (phase) {
    case "planning":
      return "plan";
    case "executing":
      return "execute";
    case "reviewing":
      return "review";
    case "final_review":
      return "final";
    case "awaiting_acceptance":
      return "acceptance";
    default:
      return "progress";
  }
}

export function collaborationProgressStatus(summary: CollaborationMessageSummary) {
  if (summary.control === "canceled") return "canceled";
  if (summary.phase === "completed") return "completed";
  if (summary.phase === "awaiting_acceptance") return "awaitingAcceptance";
  switch (summary.control) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "needs_attention":
      return "needsAttention";
    case "waiting_permission":
      return "waitingPermission";
    case "canceling":
      return "canceling";
    default:
      return undefined;
  }
}
