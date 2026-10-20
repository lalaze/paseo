import { z } from "zod";
import { PlanSchema, TaskSchema, ReviewSchema } from "./schema.js";

export const ReviewProgressSchema = z.object({
  rounds: z.number().int().min(1),
  history: z.array(
    z.object({
      round: z.number().int().min(1),
      decision: ReviewSchema.shape.decision,
      reported: z.number().int().min(0),
      added: z.number().int().min(0).optional(),
      recurring: z.number().int().min(0).optional(),
      findings: ReviewSchema.shape.findings.optional(),
    }),
  ),
});
export type ReviewProgress = z.infer<typeof ReviewProgressSchema>;

/** The reviewed snapshot, without repository patches, raw logs or operation prompts. */
export const AcceptanceReportSchema = z.object({
  review: ReviewSchema,
  changedFiles: z.array(z.string()),
  checks: z.array(z.object({ label: z.string(), exitCode: z.number().int().nullable() })),
  tasks: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      tests: z.array(z.string()),
      issues: z.array(z.string()),
    }),
  ),
});
export type AcceptanceReport = z.infer<typeof AcceptanceReportSchema>;

const ContextSchema = z.object({
  goal: z.string(),
  cwd: z.string(),
  task: TaskSchema.optional(),
  plan: PlanSchema.optional(),
  acceptance: z.array(z.string()).optional(),
  bindings: z.object({ director: z.string(), worker: z.string() }).optional(),
  taskResults: z.array(z.unknown()).optional(),
  userChangeRequests: z.array(z.object({ feedback: z.string() })).optional(),
});
/** Decode only complete scheduler envelopes; malformed or quoted examples remain ordinary messages. */
export function readCollaborationPrompt(raw: string) {
  const marker = /^\[paseo-director:([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\]\n/i.exec(raw);
  if (!marker) return;
  const start = raw.indexOf("\n\n{", marker[0].length);
  let end = raw.indexOf(`\n\nCurrent operationId=${marker[1]}.`, start);
  // COMPAT(collaborationEnglishEnvelope): added in v0.11.1, remove after 2027-04-16 once persisted Chinese prompts are retired.
  if (end < 0) end = raw.indexOf(`\n\n本轮 operationId=${marker[1]}。`, start);
  if (start < 0 || end < 0) return;
  try {
    const data = ContextSchema.parse(JSON.parse(raw.slice(start + 2, end)));
    const instruction = raw.slice(marker[0].length, start);
    let stage: "plan" | "execute" | "review" | "final";
    if (/^(?:You are the implementation AI\.|你是执行 AI。)/.test(instruction) && data.task)
      stage = "execute";
    else if (
      data.bindings &&
      /^(?:You are the planning AI\.|你是(?:主 Agent|总 AI|设计 AI)。)/.test(instruction)
    )
      stage = "plan";
    else if (
      data.plan &&
      /^(?:You are the (?:original lead|review) AI,|你是(?:原总|审核) AI，)/.test(instruction)
    )
      stage = data.taskResults ? "final" : "review";
    else return;
    return {
      operationId: marker[1],
      stage,
      goal: data.goal,
      instruction: instruction.trim(),
      task: data.task?.title,
      acceptance: data.acceptance ?? data.task?.acceptance ?? [],
      changes: data.userChangeRequests?.map((change) => change.feedback),
      raw,
    };
  } catch {
    return;
  }
}

const NoticeSchema = z.object({
  message: z.string(),
  phase: z.string().optional(),
  control: z.string().optional(),
  plan: PlanSchema.optional(),
  acceptanceReport: z.unknown().optional(),
  reviewProgress: z.unknown().optional(),
  confirmation: z
    .object({
      kind: z.enum(["plan", "final"]),
      key: z.string().optional(),
      reply: z.string().optional(),
    })
    .optional(),
});
/** Decode a background notice sent to the main Agent: marker line, one prose line, then JSON. */
export function readCollaborationNotice(id: string, raw: string) {
  const marker = `[paseo-director-chat:${id}]\n`;
  if (!raw.startsWith(marker)) return;
  const start = raw.indexOf("\n{", marker.length);
  if (start < 0) return;
  try {
    const data = NoticeSchema.parse(JSON.parse(raw.slice(start + 1)));
    return {
      instruction: raw.slice(marker.length, start).trim(),
      message: data.message,
      phase: data.phase,
      control: data.control,
      confirmation: data.confirmation?.kind,
      reply: data.confirmation?.reply,
      plan: data.plan ?? persistedNoticePlan(data.confirmation),
      acceptanceReport: optionalReport(AcceptanceReportSchema, data.acceptanceReport),
      reviewProgress: optionalReport(ReviewProgressSchema, data.reviewProgress),
    };
  } catch {
    return;
  }
}

// A malformed optional snapshot must not hide the notice or its confirmation actions.
function optionalReport<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// COMPAT(collaborationPlanNotice): added in v0.11.1, remove after 2027-04-13 once saved notices carry plan.
function persistedNoticePlan(confirmation: z.infer<typeof NoticeSchema>["confirmation"]) {
  if (confirmation?.kind !== "plan" || !confirmation.key) return;
  const prefix = /^plan:\d+:/u.exec(confirmation.key);
  if (!prefix) return;
  try {
    return PlanSchema.parse(JSON.parse(confirmation.key.slice(prefix[0].length)));
  } catch {
    return;
  }
}
