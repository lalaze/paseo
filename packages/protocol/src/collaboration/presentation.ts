import { z } from "zod";
import { PlanSchema, TaskSchema } from "./schema.js";

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
  const end = raw.indexOf(`\n\n本轮 operationId=${marker[1]}。`, start);
  if (start < 0 || end < 0) return;
  try {
    const data = ContextSchema.parse(JSON.parse(raw.slice(start + 2, end)));
    const instruction = raw.slice(marker[0].length, start);
    let stage: "plan" | "execute" | "review" | "final";
    if (instruction.startsWith("你是执行 AI。") && data.task) stage = "execute";
    else if (
      data.bindings &&
      (instruction.startsWith("你是总 AI。") || instruction.startsWith("你是设计 AI。"))
    )
      stage = "plan";
    else if (
      data.plan &&
      (instruction.startsWith("你是原总 AI，") || instruction.startsWith("你是审核 AI，"))
    )
      stage = data.taskResults ? "final" : "review";
    else return;
    return {
      operationId: marker[1],
      stage,
      goal: data.goal,
      task: data.task?.title,
      acceptance: data.acceptance ?? data.task?.acceptance ?? [],
      changes: data.userChangeRequests?.map((change) => change.feedback),
      raw,
    };
  } catch {
    return;
  }
}
