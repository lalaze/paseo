import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { readCollaborationNotice } from "@getpaseo/protocol/collaboration/presentation";
import { Conversations, validateChatApproval, type ConversationGateway } from "./conversations.js";
import { CHAT_PROMPT, noticeInstruction } from "./prompts.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import type { Conversation } from "@getpaseo/protocol/collaboration/conversation";
import {
  FakeAgents,
  FakeRepository,
  settings,
  plan,
  result,
  review,
  harness,
  reviewerSettings,
} from "./test-utils/harness.js";

class ChatAgents extends FakeAgents implements ConversationGateway {
  histories = new Map<string, AgentTimelineItem[]>();
  mains = new Map<string, string>();
  links: { agent: string; conversation: string }[] = [];
  released: string[] = [];
  failCreate = false;
  async releaseConversation(c: Conversation) {
    this.released.push(c.agentId!);
  }
  override async workspaceDirectory() {
    return this.directory;
  }
  async workspaceForDirectory() {
    return "workspace";
  }
  async takeoverProfile(agentId: string, workspaceId: string) {
    if (workspaceId !== "workspace" || !this.histories.has(agentId))
      throw new Error("当前对话不属于此工作区");
    return { provider: "current/model", modeId: "auto-review", thinkingOptionId: "high" };
  }
  async adoptConversation(c: Conversation) {
    await this.takeoverProfile(c.agentId!, c.workspaceId);
    return "bridge instructions";
  }
  async createConversation(c: Conversation) {
    if (this.failCreate) throw new Error("MCP 接入不可用");
    const id = `main-${c.id}-${c.generation ?? 0}`;
    this.mains.set(`${c.id}:${c.generation ?? 0}`, id);
    this.histories.set(id, []);
    this.states.set(id, { status: "idle", seen: false, output: "" });
    return id;
  }
  async findConversation(id: string, generation = 0) {
    const key = `${id}:${generation}`;
    return this.mains.has(key) ? [this.mains.get(key)!] : [];
  }
  async conversationHistory(id: string) {
    return this.histories.get(id) ?? [];
  }
  async appendConversationLink(agent: string, conversation: string) {
    if (!this.links.some((l) => l.agent === agent && l.conversation === conversation))
      this.links.push({ agent, conversation });
  }
  override async inspect(agentId: string, id?: string) {
    const state = await super.inspect(agentId);
    return this.histories.has(agentId)
      ? {
          ...state,
          seen: this.histories
            .get(agentId)!
            .some((i) => i.type === "user_message" && i.clientMessageId === id),
        }
      : state;
  }
  override async send(agent: string, id: string, prompt: string) {
    await super.send(agent, id, prompt);
    if (this.histories.has(agent))
      this.histories.get(agent)!.push({ type: "user_message", text: prompt, clientMessageId: id });
  }
  user(agent: string, id: string, text: string) {
    this.histories.get(agent)!.push({ type: "user_message", text, messageId: id });
  }
  idle(agent: string) {
    this.states.set(agent, { status: "idle", seen: true, output: "普通自然语言回复" });
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "director-chat-"));
  const store = new Store(join(dir, "db")),
    gateway = new ChatAgents(),
    repo = new FakeRepository();
  gateway.directory = dir;
  store.saveSettings(settings());
  const engine = new Engine(store, gateway, repo),
    chats = new Conversations(store, engine, gateway);
  t.onTestFinished(async () => {
    await chats.close();
    await engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, gateway, repo, engine, chats };
}

test("blank native conversations don't prepare a branch; duplicate creation is idempotent", async (t) => {
  const h = await fixture(t);
  const first = await h.chats.open({ requestId: "new", workspaceId: "workspace", fresh: true });
  assert.ok(first.agentId);
  assert.equal(h.store.all().length, 0);
  assert.equal(h.gateway.sent.length, 0);
  const again = await h.chats.open({ requestId: "new", workspaceId: "workspace", fresh: true });
  assert.equal(again.agentId, first.agentId);
  assert.equal(h.gateway.mains.size, 1);
  assert.equal((await h.chats.open({ requestId: "open", workspaceId: "workspace" })).id, first.id);
});

test("visual mode selection persists, starts one direct task, and cannot change an active task", async (t) => {
  const h = await fixture(t);
  h.store.saveSettings(reviewerSettings());
  const input = {
    requestId: "light",
    workspaceId: "workspace",
    fresh: true,
    mode: "execute_review" as const,
  };
  const c = await h.chats.open(input);
  assert.equal(c.mode, "execute_review");
  assert.equal(h.store.all().length, 0);
  assert.equal((await h.chats.open(input)).id, c.id);
  h.gateway.user(c.agentId!, "goal", "修复输入校验");
  const start = { sourceMessageId: "goal", goal: "修复输入校验" };
  const created = await h.chats.start(c.id, start);
  assert.deepEqual(await h.chats.start(c.id, start), created);
  const run = h.store.all()[0];
  assert.equal(run.mode, "execute_review");
  assert.equal(run.phase, "executing");
  assert.equal(run.tasks.length, 1);
  assert.equal(h.store.all().length, 1);
  await assert.rejects(h.chats.open({ ...input, mode: "full" }), /不能切换/);
  assert.equal((await h.chats.open(input)).mode, "execute_review");
});

test("starting a worktree conversation prepares an isolated workspace", async (t) => {
  const h = await fixture(t);
  const flags: boolean[] = [];
  h.repo.prepare = async (repository, runId, currentWorkspace = false) => {
    flags.push(currentWorkspace);
    return {
      repository,
      cwd: currentWorkspace ? repository : `/worktrees/${runId}`,
      baseCommit: "base",
      branch: `director/${runId}`,
      ...(currentWorkspace ? {} : { workspaceId: `wt-${runId}` }),
    };
  };
  const c = await h.chats.open({
    requestId: "isolated",
    workspaceId: "workspace",
    goal: "实现功能",
    isolation: "worktree",
  });
  assert.equal(h.store.conversation(c.id).isolation, "worktree");
  const status = await h.chats.status(c.id);
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: status.latestUserMessage!.id,
  });
  assert.deepEqual(flags, [false]);
  assert.equal(h.store.all()[0]?.workspaceId, `wt-${h.store.all()[0]?.id}`);
  assert.notEqual(h.store.all()[0]?.cwd, h.dir);
});

test("lightweight conversations without an independent reviewer do not create sessions", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.chats.open({ requestId: "light", workspaceId: "workspace", mode: "execute_review" }),
    /独立审核/,
  );
  assert.equal(h.store.conversations().length, 0);
  assert.equal(h.gateway.mains.size, 0);
});

test("only the latest real user message can start a task, with retries creating one run", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "new", workspaceId: "workspace", goal: "实现功能" });
  const status = await h.chats.status(c.id);
  assert.equal(status.latestUserMessage?.text, "实现功能");
  await assert.rejects(
    h.chats.start(c.id, { goal: "实现功能", sourceMessageId: "invented" }),
    /真实用户/,
  );
  const a = await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: status.latestUserMessage!.id,
  });
  const b = await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: status.latestUserMessage!.id,
  });
  assert.deepEqual(a, b);
  assert.equal(h.store.all().length, 1);
  assert.equal(h.store.all()[0].chat?.mainAgentId, c.agentId);
});

test("native chat plan, child execution, review and explicit acceptance form a complete workflow", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "flow", workspaceId: "workspace", goal: "实现功能" });
  const initial = await h.chats.status(c.id);
  await h.chats.start(c.id, { goal: "实现功能", sourceMessageId: initial.latestUserMessage!.id });
  h.gateway.idle(c.agentId!);
  async function until(kind: "plan" | "execute" | "final") {
    for (let i = 0; i < 30; i++) {
      await h.engine.tick();
      const run = h.chats.summary(c.id).run!,
        op = run.operations.find((o) => o.id === run.activeOperationId);
      if (op?.kind === kind && op.state === "sent") return op;
    }
    throw new Error(JSON.stringify(h.chats.summary(c.id)));
  }
  const design = await until("plan");
  // Ordinary conversation while waiting for a structured tool submission is fine.
  h.gateway.user(c.agentId!, "question", "进度怎么样？");
  h.gateway.idle(c.agentId!);
  await h.engine.tick();
  assert.equal(h.chats.summary(c.id).run?.control, "running");
  await h.chats.submit(c.id, design.id, plan);
  await h.engine.tick();
  const worker = await until("execute");
  h.gateway.user(c.agentId!, "question2", "先解释一下这个方案");
  await h.chats.status(c.id);
  await h.engine.tick();
  assert.equal(h.chats.summary(c.id).run?.activeOperationId, worker.id);
  await assert.rejects(h.chats.submit(c.id, worker.id, result), /无权/);
  h.gateway.states.set(worker.agentId!, {
    status: "idle",
    seen: true,
    output: JSON.stringify(result),
  });
  await h.engine.tick();
  const audit = await until("final");
  await h.chats.submit(c.id, audit.id, review(true));
  h.gateway.idle(c.agentId!);
  await h.engine.tick();
  assert.equal(h.chats.summary(c.id).run?.phase, "awaiting_acceptance");
  await h.chats.tick();
  h.gateway.idle(c.agentId!);
  const pending = h.chats.summary(c.id).confirmation!;
  assert.ok(pending);
  // The app renders this notice as the acceptance stage card; the Agent owes one report.
  const notice = h.gateway.sent.find((entry) => entry.opId === pending.noticeId);
  const card = readCollaborationNotice(pending.noticeId, notice!.prompt);
  assert.equal(card?.confirmation, "final");
  assert.match(card!.instruction, /实际改动、验证及结果、已知限制/);
  assert.match(card!.reply!, /单独回复“验收通过”.+单独回复“不采纳成果”.+描述需要修改的内容/);
  h.gateway.user(c.agentId!, "ambiguous", "好");
  await assert.rejects(
    h.chats.control(c.id, {
      action: "accept_final",
      sourceMessageId: "ambiguous",
      confirmationKey: pending.key,
    }),
    /单独回复/,
  );
  h.gateway.user(c.agentId!, "approve", "验收通过");
  await h.chats.control(c.id, {
    action: "accept_final",
    sourceMessageId: "approve",
    confirmationKey: pending.key,
  });
  await h.chats.control(c.id, {
    action: "accept_final",
    sourceMessageId: "approve",
    confirmationKey: pending.key,
  });
  assert.equal(h.chats.summary(c.id).run?.phase, "completed");
  h.gateway.user(c.agentId!, "change", "请补充输入校验");
  await h.chats.control(c.id, {
    action: "request_changes",
    sourceMessageId: "change",
    feedback: "补充输入校验",
  });
  assert.equal(h.chats.summary(c.id).run?.phase, "planning");
});

test("approval rejects quotes, model text, stale anchors and approvals before the question", () => {
  const notice: AgentTimelineItem = {
    type: "user_message",
    clientMessageId: "notice",
    text: "请验收",
  };
  for (const text of [
    "好",
    "同意",
    "他说验收通过",
    "‘验收通过’",
    "> 验收通过",
    "```验收通过```",
    "验收通过，但是请先改完",
  ]) {
    assert.throws(() =>
      validateChatApproval([notice, { type: "user_message", messageId: "u", text }], {
        action: "accept_final",
        noticeId: "notice",
        messageId: "u",
      }),
    );
  }
  assert.throws(() =>
    validateChatApproval(
      [notice, { type: "assistant_message", messageId: "a", text: "验收通过" }],
      { action: "accept_final", noticeId: "notice", messageId: "a" },
    ),
  );
  assert.throws(() =>
    validateChatApproval([{ type: "user_message", messageId: "u", text: "验收通过" }, notice], {
      action: "accept_final",
      noticeId: "notice",
      messageId: "u",
    }),
  );
  validateChatApproval([notice, { type: "user_message", messageId: "u", text: "验收通过。" }], {
    action: "accept_final",
    noticeId: "notice",
    messageId: "u",
  });
});

test("migration freezes dispatch, preserves in-flight operations and retries creation without duplicating work", async (t) => {
  const h = await fixture(t);
  const id = await h.engine.create({
    requestId: "legacy",
    repository: h.dir,
    goal: "实现功能",
    settings: settings(),
  });
  for (let i = 0; i < 4; i++) await h.engine.tick();
  const before = h.store.get(id),
    op = before.operations.find((o) => o.id === before.activeOperationId)!;
  h.gateway.failCreate = true;
  await h.chats.migrate();
  await h.chats.tick();
  await h.engine.tick();
  assert.equal(h.store.get(id).activeOperationId, op.id);
  assert.ok(h.chats.summary(h.store.get(id).migrationConversationId!).error);
  h.gateway.failCreate = false;
  await h.chats.tick();
  const after = h.store.get(id);
  assert.equal(after.activeOperationId, op.id);
  assert.equal(after.operations[0].agentId, op.agentId);
  assert.notEqual(after.directorAgentId, op.agentId);
  const count = h.gateway.created.length;
  await h.chats.migrate();
  await h.chats.tick();
  assert.equal(h.gateway.mains.size, 1);
  assert.equal(h.gateway.created.length, count);
});

test("migration retains every persisted lifecycle state, completed outcomes and task evidence", async (t) => {
  const h = await fixture(t);
  for (const [index, state] of [
    { phase: "planning", control: "running" },
    { phase: "executing", control: "running" },
    { phase: "executing", control: "paused" },
    { phase: "final_review", control: "needs_attention" },
    { phase: "awaiting_acceptance", control: "paused" },
    { phase: "completed", control: "running" },
    { phase: "executing", control: "canceled" },
  ].entries()) {
    const id = await h.engine.create({
      requestId: `legacy-${index}`,
      repository: h.dir,
      goal: "实现功能",
      settings: settings(),
    });
    const run = h.store.get(id);
    Object.assign(run, state);
    run.plan = plan;
    run.planApproved = index !== 2;
    h.store.save(run);
  }
  const before = h.store.all();
  await h.chats.migrate();
  await h.chats.tick();
  for (const run of before) {
    const after = h.store.get(run.id);
    assert.equal(after.phase, run.phase);
    assert.equal(after.control, run.control);
    assert.deepEqual(after.plan, run.plan);
    assert.equal(after.planApproved, run.planApproved);
    assert.ok(after.chat);
  }
  assert.equal(h.gateway.sent.filter((s) => s.prompt.startsWith("[paseo-director:")).length, 0);
});

test("busy main chats queue/coalesce notices, and a lost send acknowledgment is reconciled once", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({
      requestId: "notifications",
      workspaceId: "workspace",
      goal: "实现功能",
    });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  await h.chats.tick();
  assert.equal(h.gateway.sent.length, 1);
  h.gateway.idle(c.agentId!);
  const original = h.gateway.send.bind(h.gateway);
  h.gateway.send = async (...args) => {
    await original(...args);
    throw new Error("lost response");
  };
  await h.chats.tick();
  assert.equal(h.gateway.sent.length, 2);
  h.gateway.send = original;
  h.gateway.idle(c.agentId!);
  await h.chats.tick();
  assert.equal(h.gateway.sent.length, 2);
  assert.equal(h.store.conversation(c.id).notices.at(-1)?.state, "sent");
});

test("chat revision stops workers, rejects stale submissions, and doesn't cancel its own main turn", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "revision", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  h.gateway.idle(c.agentId!);
  for (let i = 0; i < 3; i++) await h.engine.tick();
  const op = h.chats.summary(c.id).run!.operations.at(-1)!;
  h.gateway.user(c.agentId!, "revise", "增加登录功能");
  await h.chats.control(c.id, {
    action: "revise",
    sourceMessageId: "revise",
    goal: "实现功能并增加登录",
  });
  assert.equal(h.gateway.stopped.includes(c.agentId!), false);
  await assert.rejects(h.chats.submit(c.id, op.id, plan), /无权/);
  assert.equal(h.chats.summary(c.id).run?.goal, "实现功能并增加登录");
});

test("a chat note is recorded once without pausing or re-planning the run", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "note", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  h.gateway.idle(c.agentId!);
  for (let i = 0; i < 3; i++) await h.engine.tick();
  h.gateway.user(c.agentId!, "note", "测量数据不要提交");
  const input = { action: "note" as const, sourceMessageId: "note", feedback: "测量数据不要提交" };
  await h.chats.control(c.id, input);
  await h.chats.control(c.id, input);
  const run = h.chats.summary(c.id).run!;
  assert.deepEqual(
    run.notes?.map((note) => note.text),
    ["测量数据不要提交"],
  );
  assert.equal(run.control, "running");
  assert.equal(run.goal, "实现功能");
});

test("chat history with later user turns does not invalidate a main operation's submitted tool result", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  const run = h.run();
  run.chat = { version: 1, conversationId: "chat", mainAgentId: op.agentId! };
  h.store.save(run);
  await h.engine.submit(h.id, "director", op.id, plan);
  h.agents.states.set(op.agentId!, {
    status: "idle",
    seen: true,
    interrupted: true,
    output: "你问的这个问题，可以这样理解…",
  });
  await h.engine.tick();
  assert.equal(h.run().control, "running");
  assert.deepEqual(h.run().plan, plan);
});

test("conversation creation recovers a committed run after its linking checkpoint was lost", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "crash", workspaceId: "workspace", goal: "实现功能" });
  const source = (await h.chats.status(c.id)).latestUserMessage!.id;
  const before = h.store.conversation(c.id);
  await h.chats.start(c.id, { sourceMessageId: source, goal: "实现功能" });
  before.receipts[`start:${source}`] = { action: "start", state: "pending" };
  h.store.saveConversation(before);
  const restarted = new Conversations(h.store, h.engine, h.gateway);
  await restarted.tick();
  assert.equal(restarted.summary(c.id).runId, h.store.all()[0].id);
  assert.equal(h.store.all().length, 1);
  await restarted.close();
});

test("an unavailable native tool handshake is visible and no background task is fabricated", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "no-tools", workspaceId: "workspace", goal: "实现功能" });
  h.gateway.idle(c.agentId!);
  await h.chats.tick();
  assert.match(h.chats.summary(c.id).error!, /协作工具/);
  assert.equal(h.store.all().length, 0);
  await h.chats.status(c.id);
  assert.equal(h.chats.summary(c.id).error, undefined);
});

test("a main Agent can submit context fetched from tools before a queued prompt is sent", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({
      requestId: "tool-context",
      workspaceId: "workspace",
      goal: "实现功能",
    });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  await h.engine.tick();
  await h.engine.tick();
  const op = (await h.chats.status(c.id)).operation!;
  assert.equal(op.state, "ready");
  await h.chats.submit(c.id, op.id, plan);
  // The same interactive chat turn is still running and no operation prompt
  // exists in its history. A valid MCP submission is sufficient for acceptance.
  await h.engine.tick();
  assert.deepEqual(h.chats.summary(c.id).run?.plan, plan);
  assert.equal(h.chats.summary(c.id).run?.control, "running");
});

test("resync replaces a missing main conversation without replacing child work or restarting the run", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({
      requestId: "missing-main",
      workspaceId: "workspace",
      goal: "实现功能",
    });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  const runId = h.chats.summary(c.id).runId;
  h.gateway.states.delete(c.agentId!);
  await h.chats.resync(c.id);
  const restored = h.chats.summary(c.id);
  assert.notEqual(restored.agentId, c.agentId);
  assert.equal(restored.runId, runId);
  assert.equal(restored.run?.chat?.mainAgentId, restored.agentId);
  assert.equal(h.store.all().length, 1);
  await h.chats.resync(c.id);
  assert.equal(h.gateway.mains.size, 2);
});

test("revision keeps retrying an asynchronous worker stop and discards its late result", async (t) => {
  const h = await fixture(t),
    c = await h.chats.open({ requestId: "async-stop", workspaceId: "workspace", goal: "实现功能" });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  await h.engine.tick();
  await h.engine.tick();
  await h.chats.submit(c.id, (await h.chats.status(c.id)).operation!.id, plan);
  await h.engine.tick();
  for (let i = 0; i < 4; i++) await h.engine.tick();
  const before = h.chats.summary(c.id).run!,
    op = before.operations.find((o) => o.id === before.activeOperationId)!;
  assert.equal(op.kind, "execute");
  const stop = h.gateway.stop.bind(h.gateway);
  let stopping = true;
  h.gateway.stop = async (id) => {
    if (!stopping) await stop(id);
  };
  h.gateway.user(c.agentId!, "new-goal", "增加登录功能");
  await assert.rejects(
    h.chats.control(c.id, {
      action: "revise",
      sourceMessageId: "new-goal",
      goal: "实现功能并增加登录",
    }),
    /正在停止/,
  );
  stopping = false;
  await h.chats.tick();
  const after = h.chats.summary(c.id).run!;
  assert.equal(after.goal, "实现功能并增加登录");
  assert.equal(after.phase, "planning");
  await assert.rejects(h.engine.submit(after.id, op.taskId!, op.id, result), /已经结束/);
});

test("takeover preserves history and agent identity, leaves worker bindings intact and ignores old instructions", async (t) => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", [
    { type: "user_message", messageId: "old", text: "实现旧任务" },
  ]);
  h.gateway.idle("existing");
  const original = h.store.settings()!;
  original.workerProfileId = original.directorProfileId;
  h.store.saveSettings(original);
  const c = await h.chats.open({
    requestId: "take",
    workspaceId: "workspace",
    agentId: "existing",
  });
  assert.equal(c.agentId, "existing");
  assert.equal(h.gateway.mains.size, 0);
  assert.equal(h.store.all().length, 0);
  assert.equal(h.gateway.histories.get("existing")![0].type, "user_message");
  const snapshot = h.store.conversation(c.id).settings;
  assert.equal(
    snapshot.profiles.find((p) => p.id === snapshot.directorProfileId)!.provider,
    "current/model",
  );
  assert.equal(snapshot.workerProfileId, original.workerProfileId);
  assert.equal(
    snapshot.profiles.find((p) => p.id === snapshot.workerProfileId)!.provider,
    "vendor-a/model-a",
  );
  assert.deepEqual(h.store.settings(), original);
  assert.equal((await h.chats.status(c.id)).latestUserMessage, undefined);
  await assert.rejects(
    h.chats.start(c.id, { sourceMessageId: "old", goal: "实现旧任务" }),
    /真实用户/,
  );
  await h.chats.open({ requestId: "again", workspaceId: "workspace", agentId: "existing" });
  assert.equal(h.gateway.sent.length, 1);
  assert.equal(h.store.conversations().length, 1);
  h.gateway.idle("existing");
  h.gateway.user("existing", "new", "实现新任务");
  await h.chats.start(c.id, { sourceMessageId: "new", goal: "实现新任务" });
  assert.equal(h.store.all()[0].chat!.mainAgentId, "existing");
});

test("takeover waits for the current turn, survives reload and delivers each command once", async (t) => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", []);
  h.gateway.states.set("existing", { status: "running", seen: false, output: "" });
  const input = {
    requestId: "take",
    workspaceId: "workspace",
    agentId: "existing",
    goal: "实现功能",
  };
  const c = await h.chats.open(input);
  assert.equal(h.gateway.sent.length, 0);
  assert.equal(h.gateway.stopped.length, 0);
  await h.chats.close();
  const restarted = new Conversations(h.store, h.engine, h.gateway);
  t.onTestFinished(() => restarted.close());
  h.gateway.idle("existing");
  await restarted.tick();
  assert.equal(h.gateway.sent.length, 1);
  assert.match(h.gateway.sent[0].prompt, /^实现功能/);
  await restarted.open(input);
  assert.equal(h.gateway.sent.length, 1);
  assert.equal((await restarted.status(c.id)).latestUserMessage!.id, h.gateway.sent[0].opId);
  h.gateway.idle("existing");
  await restarted.open({ ...input, requestId: "second", goal: "增加搜索" });
  assert.equal(h.gateway.sent.length, 2);
  assert.equal(h.store.conversations().length, 1);
  h.gateway.histories.delete("existing");
  h.gateway.states.delete("existing");
  await assert.rejects(restarted.resync(c.id), /原对话已不可用/);
  assert.equal(h.gateway.mains.size, 0);
});

test("takeover validates ownership before persisting anything", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.chats.open({ requestId: "invalid", workspaceId: "other", agentId: "unknown" }),
    /工作区/,
  );
  assert.equal(h.store.conversations().length, 0);
});

test("ambiguous takeover delivery requires resync and never creates a replacement agent", async (t) => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", []);
  h.gateway.idle("existing");
  const send = h.gateway.send.bind(h.gateway);
  let fail = true;
  h.gateway.send = async (...args: Parameters<typeof send>) => {
    if (fail) throw new Error("lost connection");
    await send(...args);
  };
  await assert.rejects(
    h.chats.open({ requestId: "take", workspaceId: "workspace", agentId: "existing" }),
    /lost connection/,
  );
  const c = h.store.conversations()[0];
  await h.chats.tick();
  assert.match(h.chats.summary(c.id).error!, /无法确认/);
  assert.equal(h.gateway.sent.length, 0);
  assert.equal(h.gateway.mains.size, 0);
  fail = false;
  await h.chats.resync(c.id);
  assert.equal(h.gateway.sent.length, 1);
  assert.equal(h.gateway.sent[0].opId, c.takeover!.messages[0].id);
  h.gateway.idle("existing");
  await h.chats.tick();
  assert.match(h.chats.summary(c.id).error!, /协作工具/);
  await h.chats.status(c.id);
  assert.equal(h.chats.summary(c.id).error, undefined);
});

test("workers receive the persisted approval made in an adopted main conversation", async (t) => {
  const { buildPrompt } = await import("./prompts");
  const h = await fixture(t),
    saved = settings();
  saved.requirePlanApproval = true;
  h.store.saveSettings(saved);
  h.gateway.histories.set("existing", []);
  h.gateway.idle("existing");
  const c = await h.chats.open({
    requestId: "take",
    workspaceId: "workspace",
    agentId: "existing",
    goal: "实现功能",
  });
  const status = await h.chats.status(c.id);
  await h.chats.start(c.id, { sourceMessageId: status.latestUserMessage!.id, goal: "实现功能" });
  const runId = h.chats.summary(c.id).runId!;
  await h.engine.tick();
  const op = h.store.get(runId).operations.find((o) => o.kind === "plan")!;
  await h.chats.submit(c.id, op.id, plan);
  h.gateway.idle("existing");
  await h.engine.tick();
  await h.chats.tick();
  const approval = h.chats.summary(c.id).confirmation!;
  h.gateway.user("existing", "approval", "批准方案");
  await h.chats.control(c.id, {
    action: "approve_plan",
    sourceMessageId: "approval",
    confirmationKey: approval.key,
  });
  const run = h.store.get(runId);
  const prompt = buildPrompt(run, "execute", "test-operation", run.tasks[0].spec.id);
  const start = prompt.indexOf("\n\n") + 2,
    end = prompt.indexOf("\n\n本轮 operationId=");
  const evidence = JSON.parse(prompt.slice(start, end)).workflowEvidence;
  assert.equal(evidence.planApproval.approved, true);
  assert.equal(evidence.planApproval.required, true);
  assert.equal(evidence.planApproval.userApprovedAt, new Date(run.planApprovedAt!).toISOString());
});

test("a stalled poll of one conversation does not delay tool calls from another", async (t) => {
  const h = await fixture(t);
  const slow = await h.chats.open({ requestId: "slow", workspaceId: "workspace", fresh: true });
  const quick = await h.chats.open({ requestId: "quick", workspaceId: "workspace", fresh: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.gateway.inspect.bind(h.gateway);
  h.gateway.inspect = async (agentId: string, id?: string) => {
    if (agentId === slow.agentId) await gate;
    return original(agentId, id);
  };
  const tick = h.chats.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = await Promise.race([
    h.chats.status(quick.id),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200)),
  ]);
  assert.notEqual(
    status,
    "blocked",
    "the quick conversation's status call must not wait on the slow conversation's poll",
  );
  assert.equal((status as { id: string }).id, quick.id);
  release();
  await tick;
});

test("main Agent replies stay out of the stage card and end acceptance with exact next actions", () => {
  assert.match(CHAT_PROMPT, /不要复述卡片内容/);
  assert.match(CHAT_PROMPT, /不要描述后台、调度器、通知或工具调用过程/);
  assert.match(CHAT_PROMPT, /有什么变化、下一步是什么、用户是否需要操作/);
  assert.match(CHAT_PROMPT, /不要轮询或连续重复调用它来等待进展/);
  const report = ["实际改动：", "验证：", "已知限制：", "下一步："].map((section) =>
    CHAT_PROMPT.indexOf(section),
  );
  assert.ok(report.every((index, i) => index > 0 && (i === 0 || index > report[i - 1])));
  assert.match(CHAT_PROMPT, /单独回复“验收通过”.+单独回复“不采纳成果”.+描述需要修改的内容以返工/);
  assert.match(CHAT_PROMPT, /批准工具必须引用待确认 confirmation\.key 和最新真实用户消息/);
  for (const kind of [undefined, "plan", "final"] as const) {
    // The app splits the notice at the first line break before its JSON context.
    assert.doesNotMatch(noticeInstruction(kind), /[\n{]/);
    assert.match(noticeInstruction(kind), /不要复述卡片摘要，不要描述后台或调度过程/);
  }
});

async function advanceTo(
  h: Awaited<ReturnType<typeof fixture>>,
  id: string,
  kind: "plan" | "execute",
) {
  for (let i = 0; i < 30; i++) {
    await h.engine.tick();
    const run = h.chats.summary(id).run!;
    const op = run.operations.find((o) => o.id === run.activeOperationId);
    if (op?.kind === kind && op.state === "sent") return op;
  }
  throw new Error(`没有到达 ${kind}: ${JSON.stringify(h.chats.summary(id))}`);
}

test("exiting collaboration before a task starts closes the conversation and refuses every tool", async (t) => {
  const h = await fixture(t);
  const c = await h.chats.open({
    requestId: "close-idle",
    workspaceId: "workspace",
    goal: "实现功能",
  });
  assert.equal(h.store.all().length, 0);
  assert.deepEqual(await h.chats.disable(c.id, { cancelRunning: false }), { ok: true });
  const stored = h.store.conversation(c.id);
  assert.ok(stored.disabledAt);
  // History keeps the record and the main session is released back to a normal chat.
  assert.equal(h.store.conversations().length, 1);
  assert.deepEqual(h.gateway.released, [c.agentId]);
  assert.equal(h.gateway.stopped.length, 0);
  // Idempotent: a repeat converges without moving the timestamp.
  assert.deepEqual(await h.chats.disable(c.id), { ok: true });
  assert.equal(h.store.conversation(c.id).disabledAt, stored.disabledAt);
  // Every tool lookup is refused once the conversation is closed.
  await assert.rejects(h.chats.start(c.id, { sourceMessageId: "x", goal: "y" }), /关闭/);
  await assert.rejects(h.chats.status(c.id), /关闭/);
  await assert.rejects(h.chats.resync(c.id), /关闭/);
  await assert.rejects(h.chats.control(c.id, { action: "cancel", sourceMessageId: "x" }), /关闭/);
});

test("exiting collaboration during a run cancels it, keeps the branch and stops only the role session", async (t) => {
  const h = await fixture(t);
  const c = await h.chats.open({
    requestId: "close-run",
    workspaceId: "workspace",
    goal: "实现功能",
  });
  await h.chats.start(c.id, {
    goal: "实现功能",
    sourceMessageId: (await h.chats.status(c.id)).latestUserMessage!.id,
  });
  h.gateway.idle(c.agentId!);
  const design = await advanceTo(h, c.id, "plan");
  await h.chats.submit(c.id, design.id, plan);
  const worker = await advanceTo(h, c.id, "execute");
  assert.ok(worker.agentId && worker.agentId !== c.agentId);
  // A task can start after the app read an idle conversation. Refuse that stale exit until
  // the user confirms stopping the run, without releasing its identity or stopping the worker.
  await assert.rejects(h.chats.disable(c.id, { cancelRunning: false }), /确认停止/);
  assert.equal(h.store.conversation(c.id).disabledAt, undefined);
  assert.equal(h.store.get(h.chats.summary(c.id).runId!).control, "running");
  assert.deepEqual(h.gateway.released, []);
  assert.deepEqual(h.gateway.stopped, []);
  await h.chats.disable(c.id, { cancelRunning: true });
  const run = h.store.get(h.chats.summary(c.id).runId!);
  assert.equal(run.control, "canceled");
  assert.ok(h.store.conversation(c.id).disabledAt);
  assert.ok(h.gateway.stopped.includes(worker.agentId!));
  // Cancel never interrupts the user's own main conversation.
  assert.equal(h.gateway.stopped.includes(c.agentId!), false);
  // Late role submissions are refused, and the chat can no longer submit either.
  await assert.rejects(h.chats.submit(c.id, worker.id, result), /关闭/);
  await assert.rejects(h.engine.submit(run.id, "task-1", worker.id, result));
});

test("closing clears the pending confirmation and unsent notices so no stale card survives", async (t) => {
  const h = await fixture(t);
  const c = await h.chats.open({
    requestId: "close-card",
    workspaceId: "workspace",
    goal: "实现功能",
  });
  const stored = h.store.conversation(c.id);
  stored.confirmation = { key: "final:artifact", kind: "final", noticeId: "notice-1" };
  stored.notices.push({
    id: "notice-1",
    key: "final",
    text: "验收",
    state: "pending",
    createdAt: Date.now(),
  });
  h.store.saveConversation(stored);
  await h.chats.disable(c.id);
  const after = h.store.conversation(c.id);
  assert.equal(after.confirmation, undefined);
  assert.equal(after.noticeKey, undefined);
  assert.equal(
    after.notices.every((notice) => notice.state === "sent"),
    true,
  );
  assert.equal(h.chats.summary(c.id).confirmation, undefined);
});

test("a closed conversation never revives across a restart, a tick or a reused request id", async (t) => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", []);
  h.gateway.idle("existing");
  const c = await h.chats.open({
    requestId: "close-reopen",
    workspaceId: "workspace",
    agentId: "existing",
    goal: "实现功能",
  });
  await h.chats.disable(c.id);
  const sent = h.gateway.sent.length;
  const stopped = h.gateway.stopped.length;
  const restarted = new Conversations(h.store, h.engine, h.gateway);
  t.onTestFinished(() => restarted.close());
  for (let i = 0; i < 5; i++) await restarted.tick();
  assert.equal(h.gateway.sent.length, sent);
  assert.equal(h.gateway.stopped.length, stopped);
  assert.ok(h.store.conversation(c.id).disabledAt);
  // Replaying the closed request id is rejected outright: it must never reuse the digest id and
  // overwrite the closed record.
  await assert.rejects(
    restarted.open({
      requestId: "close-reopen",
      workspaceId: "workspace",
      agentId: "existing",
      goal: "重放",
    }),
    /关闭/,
  );
  assert.equal(h.store.conversations().length, 1);
  // Re-enabling in the same chat takes over under a new request and leaves the closed record alone.
  const again = await restarted.open({
    requestId: "close-reopen-2",
    workspaceId: "workspace",
    agentId: "existing",
    goal: "再次启用",
  });
  assert.notEqual(again.id, c.id);
  assert.ok(h.store.conversation(c.id).disabledAt);
  assert.equal(h.store.conversation(again.id).disabledAt, undefined);
  assert.equal(h.store.conversations().length, 2);
});

test("a failed exit keeps the conversation active and a retry converges", async (t) => {
  const h = await fixture(t);
  const c = await h.chats.open({
    requestId: "close-fail",
    workspaceId: "workspace",
    goal: "实现功能",
  });
  const release = h.gateway.releaseConversation.bind(h.gateway);
  let attempts = 0;
  h.gateway.releaseConversation = async () => {
    attempts += 1;
    throw new Error("release failed");
  };
  await assert.rejects(h.chats.disable(c.id), /release failed/);
  assert.equal(h.store.conversation(c.id).disabledAt, undefined);
  // The chat stays enabled and still answers its own status.
  assert.equal((await h.chats.status(c.id)).id, c.id);
  h.gateway.releaseConversation = release;
  await h.chats.disable(c.id);
  // The retry re-runs the release rather than skipping it because labels were already touched.
  assert.equal(attempts, 1);
  assert.ok(h.store.conversation(c.id).disabledAt);
});

test("an open queued behind a close never re-adopts the closed conversation", async (t) => {
  const h = await fixture(t);
  const c = await h.chats.open({
    requestId: "race-ensure",
    workspaceId: "workspace",
    goal: "实现功能",
  });
  // Barrier: signal when the close is inside its lock, then hold it until the open has queued.
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.gateway.releaseConversation.bind(h.gateway);
  h.gateway.releaseConversation = async (conversation) => {
    entered();
    await gate;
    return original(conversation);
  };
  const closing = h.chats.disable(c.id);
  await started;
  const opening = h.chats.open({
    requestId: "race-ensure",
    workspaceId: "workspace",
    conversationId: c.id,
  });
  release();
  await closing;
  // The queued open re-reads under the lock, sees the close, and refuses instead of reviving it.
  await assert.rejects(opening, /关闭/);
  assert.ok(h.store.conversation(c.id).disabledAt);
});

test("a takeover that began before a close cannot resurrect the closed record", async (t) => {
  const h = await fixture(t);
  h.gateway.histories.set("existing", []);
  h.gateway.idle("existing");
  const c = await h.chats.open({
    requestId: "race-create",
    workspaceId: "workspace",
    agentId: "existing",
    goal: "实现功能",
  });
  // Barrier: the takeover awaits its profile before taking the create lock; the close lands there.
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.gateway.takeoverProfile.bind(h.gateway);
  h.gateway.takeoverProfile = async (agentId: string, workspaceId: string) => {
    entered();
    await gate;
    return original(agentId, workspaceId);
  };
  const reopening = h.chats.open({
    requestId: "race-create",
    workspaceId: "workspace",
    agentId: "existing",
    goal: "再次启用",
  });
  await started;
  await h.chats.disable(c.id);
  release();
  // Replaying the closed request id is refused, and the closed record keeps its disabledAt.
  await assert.rejects(reopening, /关闭/);
  assert.ok(h.store.conversation(c.id).disabledAt);
  assert.equal(h.store.conversations().length, 1);
});
