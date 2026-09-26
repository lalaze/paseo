import { z } from "zod";
import {
  CollaborationIsolationSchema,
  CollaborationModeSchema,
  RolePromptsSchema,
  SettingsSchema,
} from "./schema.js";

export const CollaborationCommandSchema = z.enum([
  "status",
  "settings.save",
  "prompts.save",
  "conversation.open",
  "conversation.resync",
  "run.control",
]);
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
      run: z
        .object({
          id: z.string(),
          mode: CollaborationModeSchema.optional(),
          phase: z.string(),
          control: z.string(),
          message: z.string(),
          done: z.number(),
          total: z.number(),
        })
        .optional(),
    }),
  ),
});
export type CollaborationState = z.infer<typeof CollaborationStateSchema>;
