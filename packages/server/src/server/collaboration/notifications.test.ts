import { test, expect } from "vitest";
import { harness } from "./test-utils/harness.js";
import { muteCollaborationNotification } from "./notifications.js";

test("worker completion notices are muted only for scheduler operations, never errors or user follow-ups", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const operation = await h.until("plan");
  const input = { agentId: operation.agentId!, runs: [h.run()], conversations: [] };
  expect(
    muteCollaborationNotification({
      ...input,
      reason: "finished",
      timeline: [{ type: "user_message", text: operation.prompt, messageId: operation.id }],
    }),
  ).toBe(true);
  expect(
    muteCollaborationNotification({
      ...input,
      reason: "error",
      timeline: [{ type: "user_message", text: operation.prompt, messageId: operation.id }],
    }),
  ).toBe(false);
  expect(
    muteCollaborationNotification({
      ...input,
      reason: "permission",
      timeline: [{ type: "user_message", text: operation.prompt, messageId: operation.id }],
    }),
  ).toBe(false);
  expect(
    muteCollaborationNotification({
      ...input,
      reason: "finished",
      timeline: [
        { type: "user_message", text: "Explain the changes", messageId: "manual-followup" },
      ],
    }),
  ).toBe(false);
});
