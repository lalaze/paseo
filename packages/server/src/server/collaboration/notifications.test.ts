import { test, expect } from "vitest";
import { harness } from "./test-utils/harness.js";
import { muteCollaborationNotification } from "./notifications.js";
import type { Conversation } from "@getpaseo/protocol/collaboration/conversation";

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

test("timeline-only progress cannot mute a user reply or unmute an operation's completion", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const operation = await h.until("plan");
  const noticeId = "chat-notice:progress";
  const conversation: Conversation = {
    id: "conversation",
    requestId: "request",
    workspaceId: "workspace",
    cwd: h.run().cwd,
    agentId: operation.agentId!,
    runId: h.id,
    settings: h.run().settings,
    createdAt: 1,
    state: "ready",
    receipts: {},
    notices: [
      { id: noticeId, key: "progress", text: "Progress", delivery: "timeline", state: "sent" },
    ],
  };
  const input = {
    agentId: operation.agentId!,
    reason: "finished",
    runs: [h.run()],
    conversations: [conversation],
  };
  expect(
    muteCollaborationNotification({
      ...input,
      timeline: [
        { type: "user_message", text: "Explain the changes", messageId: "question" },
        { type: "user_message", text: "Progress", clientMessageId: noticeId },
      ],
    }),
  ).toBe(false);
  expect(
    muteCollaborationNotification({
      ...input,
      timeline: [
        { type: "user_message", text: operation.prompt, clientMessageId: operation.id },
        { type: "user_message", text: "Progress", clientMessageId: noticeId },
      ],
    }),
  ).toBe(true);
});
