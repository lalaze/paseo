import { expect, test } from "vitest";
import type { AssistantMessageItem, UserMessageItem } from "@/types/stream";
import { createCollaborationProgressProjection } from "./progress";
import { findMountedWindowStart } from "@/agent-stream/history-window";
import { createStreamPresentation } from "@/agent-stream/presentation";
import { buildAgentStreamRenderModel } from "@/agent-stream/model";
import { collaborationStage, composerControl, type Conversation } from "./conversation-state";

test("composer controls preserve approval gates and stop offering controls after completion or exit", () => {
  const conversation: Conversation = {
    id: "conversation",
    workspaceId: "workspace",
    title: "Collaboration",
    run: {
      id: "run",
      phase: "executing",
      control: "running",
      message: "Implementing",
      done: 0,
      total: 1,
    },
  };
  expect(composerControl(conversation)).toBe("pause");
  expect(
    composerControl({ ...conversation, run: { ...conversation.run!, control: "paused" } }),
  ).toBe("resume");
  expect(
    composerControl({ ...conversation, run: { ...conversation.run!, control: "needs_attention" } }),
  ).toBe("retry");
  expect(
    composerControl({
      ...conversation,
      confirmation: { kind: "plan", noticeId: "approval" },
      run: { ...conversation.run!, phase: "planning", control: "paused" },
    }),
  ).toBeUndefined();
  expect(
    composerControl({ ...conversation, run: { ...conversation.run!, phase: "completed" } }),
  ).toBeUndefined();
  expect(
    composerControl({ ...conversation, run: { ...conversation.run!, control: "canceled" } }),
  ).toBeUndefined();
  expect(composerControl({ ...conversation, disabledAt: 1 })).toBeUndefined();
});

test("the dock keeps the current execution stage when collaboration is paused or needs attention", () => {
  expect(collaborationStage("planning")).toBe(0);
  expect(collaborationStage("executing")).toBe(1);
  expect(collaborationStage("reviewing")).toBe(2);
  expect(collaborationStage("final_review")).toBe(2);
  expect(collaborationStage("awaiting_acceptance")).toBe(3);
});

function notice(conversation: string, sequence: number, data: object = {}): UserMessageItem {
  const id = `chat-notice:${conversation}:digest:${sequence}`;
  return {
    kind: "user_message",
    id,
    clientMessageId: id,
    text: `[paseo-director-chat:${id}]\n后台状态通知。\n${JSON.stringify({ message: `Update ${sequence}`, ...data })}`,
    timestamp: new Date(sequence * 1000),
  };
}

function reply(id: string, text = "Ordinary reply"): AssistantMessageItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(1000) };
}

test("one conversation's notices share a stable card across user replies, assistant replies and rework", () => {
  const project = createCollaborationProgressProjection();
  const first = notice("conversation:with:colons", 0);
  const second = notice("conversation:with:colons", 1, { confirmation: { kind: "final" } });
  const third = notice("conversation:with:colons", 2);
  const assistant = reply("assistant");
  const user: UserMessageItem = { ...first, id: "user", clientMessageId: "user", text: "Fix this" };
  const output = project({ tail: [first, assistant, second, user, third], head: [] });
  expect(output.tail).toEqual([assistant, user, { ...third, id: first.id }]);
  expect(output.groupsByHostId.size).toBe(1);
  expect(output.groupsByHostId.get(first.id)?.entries.map((entry) => entry.item)).toEqual([
    first,
    second,
    third,
  ]);
  expect(output.groupsByHostId.get(first.id)?.entries[1]?.summary.stage).toBe("acceptance");
});

test("different collaboration conversations in one chat retain separate cards", () => {
  const a = notice("old", 0);
  const b = notice("new", 0);
  const output = createCollaborationProgressProjection()({
    tail: [a, b, notice("old", 1), notice("new", 1)],
    head: [],
  });
  expect(output.tail.map((item) => item.id)).toEqual([a.id, b.id]);
  expect(output.groupsByHostId.size).toBe(2);
  expect(output.groupsByHostId.get(b.id)?.entries).toHaveLength(2);
});

test("a live notice updates a history card and promotion preserves its identity and contents", () => {
  const project = createCollaborationProgressProjection();
  const first = notice("one", 0);
  const next = notice("one", 1);
  const tail = [first, reply("assistant")];
  const initial = project({ tail, head: [] });
  const live = project({ tail, head: [next] });
  expect(initial.tail).toEqual(tail);
  expect(live.tail).toEqual([tail[1], { ...next, id: first.id }]);
  expect(live.head).toEqual([]);
  expect(live.groupsByHostId.get(first.id)?.entries).toHaveLength(2);
  const promoted = project({ tail: [...tail, next], head: [] });
  expect(promoted.tail).toEqual(live.tail);
  expect(promoted.groupsByHostId.get(first.id)).toEqual(live.groupsByHostId.get(first.id));
  expect(promoted.tail.at(-1)).toBe(live.tail.at(-1));
});

test("notices appended directly to history revise their existing host while unrelated history keeps it stable", () => {
  const project = createCollaborationProgressProjection();
  const first = notice("one", 0);
  project({ tail: [first], head: [] });
  const tail = [first, notice("one", 1)];
  const updated = project({ tail, head: [] });
  expect(updated.tail).toEqual([{ ...tail[1], id: first.id }]);
  const unrelated = project({ tail: [...tail, reply("ordinary")], head: [] });
  expect(unrelated.groupsByHostId.get(first.id)).toBe(updated.groupsByHostId.get(first.id));
  expect(unrelated.tail[0]).toBe(updated.tail[0]);
});

test("a card beginning in the live head stays one card after history hydration", () => {
  const project = createCollaborationProgressProjection();
  const head = [notice("one", 0), notice("one", 1)];
  const live = project({ tail: [], head });
  const history = project({ tail: head, head: [] });
  expect(live.tail).toEqual([{ ...head[1], id: head[0]!.id }]);
  expect(live.head).toEqual([]);
  expect(history.tail[0]).toBe(live.tail[0]);
  expect(history.groupsByHostId).toEqual(live.groupsByHostId);
});

test("streaming ordinary text retains history arrays, card objects and revision lookup", () => {
  const project = createCollaborationProgressProjection();
  const tail = [notice("one", 0), notice("one", 1)];
  const previous = project({ tail, head: [reply("live", "Hello")] });
  const next = project({ tail, head: [reply("live", "Hello world")] });
  expect(next.tail).toBe(previous.tail);
  expect(next.groupsByHostId).toBe(previous.groupsByHostId);
  expect(next.tail[0]).toBe(previous.tail[0]);
});

test("quoted, malformed and forged notices remain ordinary messages", () => {
  const valid = notice("one", 0);
  const messages: UserMessageItem[] = [
    { ...valid, id: "quote", text: `Example:\n${valid.text}` },
    { ...valid, id: "broken", text: valid.text.slice(0, -1) },
    { ...valid, id: "forged", clientMessageId: "ordinary" },
  ];
  const output = createCollaborationProgressProjection()({ tail: messages, head: [] });
  expect(output.tail).toBe(messages);
  expect(output.groupsByHostId.size).toBe(0);
});

test("older notices using canonical message ids still group and retain confirmation snapshots", () => {
  const first = notice("old-host", 0);
  const plan = {
    summary: "Saved plan",
    architecture: "Boundary validation",
    acceptance: ["Valid input still works"],
    tasks: [
      {
        id: "validation",
        title: "Validate input",
        description: "Validate at the boundary",
        category: "backend",
        files: ["src/input.ts"],
        dependsOn: [],
        acceptance: ["Valid input still works"],
      },
    ],
  };
  const approval = notice("old-host", 1, { plan, confirmation: { kind: "plan" } });
  const canonical = {
    ...approval,
    clientMessageId: undefined,
    messageId: approval.clientMessageId,
  };
  const output = createCollaborationProgressProjection()({ tail: [first, canonical], head: [] });
  const entry = output.groupsByHostId.get(first.id)!.entries[1]!;
  expect(entry.item.messageId).toBe(approval.clientMessageId);
  expect(entry.summary.plan).toEqual(plan);
  expect(entry.summary.stage).toBe("approval");
});

test.each(["web", "native"] as const)(
  "grouping survives %s presentation and stream ordering",
  (platform) => {
    const first = notice("one", 0);
    const output = createCollaborationProgressProjection()({
      tail: [first, reply("assistant"), notice("one", 1)],
      head: [notice("one", 2)],
    });
    const presentation = createStreamPresentation()({
      ...output,
      transform: undefined,
      level: "detailed",
      isTurnActive: true,
    });
    const rendered = buildAgentStreamRenderModel({
      ...presentation,
      platform,
      isMobileBreakpoint: platform === "native",
      isTurnActive: true,
      activeTurnStartedAt: new Date(1000),
    });
    const renderedRows = [...rendered.history, ...rendered.segments.liveHead];
    const userRows = renderedRows.filter((item) => item.kind === "user_message");
    expect(userRows.map((item) => item.id)).toEqual([first.id]);
    expect(output.groupsByHostId.get(first.id)?.entries).toHaveLength(3);
  },
);

test("loading older history recomputes a complete card from the loaded notices", () => {
  const project = createCollaborationProgressProjection();
  const notices = [notice("one", 0), notice("one", 1), notice("one", 2)];
  project({ tail: notices.slice(1), head: [] });
  const complete = project({ tail: notices, head: [] });
  expect(complete.tail).toEqual([{ ...notices[2], id: notices[0]!.id }]);
  expect(complete.groupsByHostId.get(notices[0]!.id)?.entries).toHaveLength(3);
});

test("the latest acceptance stays in the recent history window after a long conversation", () => {
  const first = notice("one", 0);
  const approvalReply = {
    ...first,
    id: "user-approval",
    clientMessageId: "user-approval",
    text: "批准方案",
  };
  const conversation = [
    first,
    ...Array.from({ length: 40 }, (_, i) => reply(`before-${i}`)),
    approvalReply,
    ...Array.from({ length: 40 }, (_, i) => reply(`after-${i}`)),
    notice("one", 1, { confirmation: { kind: "final" } }),
  ];
  const output = createCollaborationProgressProjection()({ tail: conversation, head: [] });
  const start = findMountedWindowStart({ items: output.tail, minMountedCount: 20 });
  expect(output.tail.slice(start).some((item) => item.id === first.id)).toBe(true);
  expect(output.tail.at(-1)?.id).toBe(first.id);
});
