import { z } from "zod";
import {
  CollaborationIsolationSchema,
  CollaborationModeSchema,
  ExecutionModelSchema,
  RolePromptsSchema,
  SettingsSchema,
} from "./schema.js";

export const CollaborationCommandSchema = z.enum([
  "status",
  "settings.save",
  "prompts.save",
  "conversation.open",
  "conversation.resync",
  "conversation.disable",
  "conversation.confirm",
  "run.control",
  "run.switch_executor",
]);
export const SwitchExecutorInputSchema = z.object({
  id: z.string().min(1),
  expectedOperationId: z.string().min(1),
  token: z.number().int(),
  requestId: z.string().min(1).max(200),
  model: ExecutionModelSchema,
});
export type SwitchExecutorInput = z.infer<typeof SwitchExecutorInputSchema>;
export const SwitchExecutionModelToolSchema = SwitchExecutorInputSchema.omit({ id: true }).extend({
  sourceMessageId: z.string().min(1),
});
export type SwitchExecutionModelToolInput = z.infer<typeof SwitchExecutionModelToolSchema>;
export type CollaborationCommand = z.infer<typeof CollaborationCommandSchema>;
export const CollaborationRequestSchema = z.object({
  type: z.literal("collaboration.command.request"),
  requestId: z.string(),
  command: CollaborationCommandSchema,
  input: z.unknown(),
});
export const CollaborationResponseSchema = z.object({
  type: z.literal("collaboration.command.response"),
  payload: z.object({ requestId: z.string(), state: z.unknown() }),
});
export const CollaborationStateSchema = z.object({
  settings: SettingsSchema.nullable(),
  rolePrompts: RolePromptsSchema.optional(),
  error: z.string().nullable(),
  conversations: z.array(
    z.object({
      id: z.string(),
      mode: CollaborationModeSchema.optional(),
      isolation: CollaborationIsolationSchema.optional(),
      settings: SettingsSchema.optional(),
      requestId: z.string().optional(),
      workspaceId: z.string(),
      agentId: z.string().optional(),
      title: z.string(),
      error: z.string().optional(),
      /** Present once the user exited collaboration; the record remains for history. */
      disabledAt: z.number().optional(),
      /** The notice awaiting the user's plan approval or acceptance, when one is pending. */
      confirmation: z
        .object({
          kind: z.enum(["plan", "final"]),
          noticeId: z.string(),
          mergeTargetBranch: z.string().optional(),
        })
        .optional(),
      run: z
        .object({
          id: z.string(),
          mode: CollaborationModeSchema.optional(),
          phase: z.string(),
          control: z.string(),
          message: z.string(),
          done: z.number(),
          total: z.number(),
          deliveryStatus: z.string().optional(),
          execution: z
            .object({
              profileId: z.string(),
              model: ExecutionModelSchema.optional(),
              relay: z
                .object({
                  status: z.enum(["blocked", "stopping", "preparing", "failed"]),
                  source: z.enum(["automatic", "manual", "none"]),
                  operationId: z.string(),
                  taskId: z.string().optional(),
                  profileId: z.string(),
                  errorClass: z.literal("quota"),
                  message: z.string(),
                  manual: z.boolean(),
                  token: z.number(),
                  target: ExecutionModelSchema.optional(),
                  attempted: z.array(ExecutionModelSchema),
                  reason: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});
export type CollaborationState = z.infer<typeof CollaborationStateSchema>;
