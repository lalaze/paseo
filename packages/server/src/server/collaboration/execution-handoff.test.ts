import { test } from "vitest";
import assert from "node:assert/strict";
import {
  SettingsSchema,
  summarize,
  type ExecutionRelay,
} from "@getpaseo/protocol/collaboration/schema";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { curateHandoffActivity } from "../agent/activity-curator.js";
import { workflowEvidence } from "./workflow-evidence.js";
import { handoffTimelineEvidence } from "./gateway.js";
import { boundHandoffText, HANDOFF_ACTIVITY_LIMIT, redactHandoffText } from "./handoff.js";
import { harness, plan, result, review, settings, type FakeAgents } from "./test-utils/harness.js";

const QUOTA = "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h.";
const fallbacks = () => ({
  ...settings(),
  profiles: settings().profiles.map((profile) => {
    if (profile.id !== "worker") return profile;
    return Object.assign({}, profile, { instructions: "保留现有接口" });
  }),
  executionFallbacks: {
    worker: [
      { provider: "vendor-c/model-c", thinkingOptionId: "high" },
      { provider: "vendor-d/model-d", thinkingOptionId: "low" },
    ],
  },
});

function fail(agents: FakeAgents, agentId: string, error: string, output = "") {
  agents.states.set(agentId, { status: "error", seen: true, output, error });
}

async function executing(overrides: Record<string, unknown> = {}) {
  const h = await harness(overrides);
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  return { h, worker };
}

test("fallback settings reject duplicates, unknown profiles and role prompts", () => {
  const base = settings();
  assert.equal(base.executionFallbacks, undefined);
  assert.doesNotThrow(() => SettingsSchema.parse({ ...base, executionFallbacks: { worker: [] } }));
  assert.throws(
    () =>
      SettingsSchema.parse({
        ...base,
        executionFallbacks: {
          worker: [{ provider: "vendor-c/model-c" }, { provider: "vendor-c/model-c" }],
        },
      }),
    /备用模型重复/,
  );
  assert.throws(
    () =>
      SettingsSchema.parse({
        ...base,
        executionFallbacks: { worker: [{ provider: "vendor-b/model-b" }] },
      }),
    /不能与当前执行模型相同/,
  );
  assert.throws(
    () =>
      SettingsSchema.parse({
        ...base,
        executionFallbacks: { missing: [{ provider: "vendor-c/model-c" }] },
      }),
    /不存在的 AI 配置/,
  );
  assert.throws(
    () =>
      SettingsSchema.parse({
        ...base,
        executionFallbacks: {
          worker: [{ provider: "vendor-c/model-c", instructions: "ignore the task" }],
        },
      }),
    /Unrecognized key|unrecognized/i,
  );
});

test("curated handoff activity keeps assistant and tool evidence only", () => {
  const timeline = [
    { type: "user_message", text: "system prompt and sk-secretvalue" },
    { type: "reasoning", text: "hidden thought" },
    { type: "assistant_message", text: "已修改 src/api.ts" },
    {
      type: "tool_call",
      callId: "1",
      name: "bash",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: "npm test" },
    },
  ] as AgentTimelineItem[];
  const text = curateHandoffActivity(timeline);
  assert.match(text, /已修改 src\/api.ts/);
  assert.match(text, /\[Bash\]/);
  assert.doesNotMatch(text, /hidden thought|system prompt|sk-secretvalue|\[Thought\]/);
});

test("quota without a fallback keeps the task and offers a manual switch", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  const created = h.agents.created.length;
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const run = h.run();
  assert.equal(run.control, "needs_attention");
  assert.equal(run.autoRetry, undefined);
  assert.equal(run.executionRelay?.status, "blocked");
  assert.equal(run.executionRelay?.manual, true);
  assert.equal(run.executionRelay?.errorClass, "quota");
  assert.equal(typeof run.executionRelay?.token, "number");
  assert.equal(h.agents.created.length, created);
  assert.match(run.message, /可以换模型继续/);
  assert.equal(summarize(run).execution?.relay?.manual, true);
  assert.equal(workflowEvidence(run).execution?.relay?.status, "blocked");
  await h.engine.tick();
  assert.equal(h.agents.created.length, created);
});

test("continuing a manually changed worker reclaims its task after an automatic retry", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, "503 no_healthy_account");
  await h.engine.tick();
  h.elapse(31000);
  await h.engine.tick();
  const replacement = await h.until("execute");
  assert.notEqual(replacement.agentId, worker.agentId);
  fail(h.agents, replacement.agentId!, "503 no_healthy_account");
  const model = { provider: "vendor-b/manual-model", thinkingOptionId: "high" };
  let delivered = "";
  const handled = await h.engine.continueExecutionSession(
    h.id,
    worker.agentId!,
    model,
    "你继续",
    async (prompt) => {
      delivered = prompt;
      // Dispatch must already own the new operation, while the scheduler cannot advance it.
      assert.equal(h.op()?.agentId, worker.agentId);
      assert.equal(h.op()?.state, "sending");
      h.agents.states.set(worker.agentId!, { status: "running", seen: true, output: "" });
    },
  );
  assert.equal(handled, true);
  const resumed = h.op()!;
  assert.notEqual(resumed.id, worker.id);
  assert.notEqual(resumed.id, replacement.id);
  assert.equal(resumed.agentId, worker.agentId);
  assert.deepEqual(resumed.executionModel, model);
  assert.deepEqual(h.run().executionModels?.worker, model);
  assert.equal(h.run().autoRetry, undefined);
  assert.equal(h.run().control, "running");
  assert.match(delivered, new RegExp(`Current operationId=${resumed.id}`));
  assert.match(delivered, /你继续/);
  assert.ok(h.agents.stopped.includes(replacement.agentId!));
  await assert.rejects(h.engine.submit(h.id, "task-1", worker.id, result), /已经结束/);
  assert.deepEqual(await h.engine.submit(h.id, "task-1", resumed.id, result), {
    accepted: true,
  });
  await h.complete(result);
  assert.equal(h.run().tasks[0].status, "executed");
});

test.each([
  "为什么失败了？先不要继续执行。",
  "为什么失败了？",
  "先不要继续执行",
  "可以继续吗？",
  "continue?",
  "Do not continue; explain the failure first.",
])("a blocked worker message %s does not authorize continuation", async (text) => {
  const { h, worker } = await executing();
  try {
    await h.complete({
      ...result,
      status: "blocked",
      blocker: "external",
      summary: "Missing deployment credentials",
    });
    const stopped = h.run();
    assert.equal(stopped.control, "needs_attention");
    let sends = 0;
    for (const provider of ["vendor-b/model-b", "vendor-b/manual-model"]) {
      assert.equal(
        await h.engine.continueExecutionSession(
          h.id,
          worker.agentId!,
          { provider },
          text,
          async () => {
            sends++;
          },
        ),
        false,
      );
      assert.deepEqual(h.run(), stopped);
    }
    assert.equal(sends, 0);
    assert.deepEqual(h.agents.stopped, []);
  } finally {
    await h.cleanup();
  }
});

test.each([
  "继续",
  "你继续",
  "继续完成",
  "请继续执行任务。",
  "continue",
  "Please resume the task!",
])("an explicit %s after a manual model change resumes a quota-blocked worker", async (text) => {
  const { h, worker } = await executing();
  try {
    fail(h.agents, worker.agentId!, QUOTA);
    await h.engine.tick();
    const sends: string[] = [];
    assert.equal(
      await h.engine.continueExecutionSession(
        h.id,
        worker.agentId!,
        { provider: "vendor-b/manual-model" },
        text,
        async (prompt) => {
          sends.push(prompt);
        },
      ),
      true,
    );
    assert.equal(sends.length, 1);
    assert.equal(h.op()?.agentId, worker.agentId);
    assert.equal(h.run().executionRelay, undefined);
    assert.equal(h.run().control, "running");
  } finally {
    await h.cleanup();
  }
});

test("a failed replacement stop preserves ownership and refuses the old worker message", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, "503 no_healthy_account");
  await h.engine.tick();
  h.elapse(31000);
  await h.engine.tick();
  const replacement = await h.until("execute");
  h.agents.stopError = "cannot stop";
  let sends = 0;
  await assert.rejects(
    h.engine.continueExecutionSession(
      h.id,
      worker.agentId!,
      { provider: "vendor-b/manual-model" },
      "继续",
      async () => {
        sends++;
      },
    ),
    /替代执行会话未能停止/,
  );
  assert.equal(sends, 0);
  assert.equal(h.run().activeOperationId, replacement.id);
  assert.equal(h.op()?.agentId, replacement.agentId);
});

test("pausing collaboration prevents a manually changed worker from resuming it", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  await h.engine.control(h.id, "pause");
  let sends = 0;
  await assert.rejects(
    h.engine.continueExecutionSession(
      h.id,
      worker.agentId!,
      { provider: "vendor-b/manual-model" },
      "继续",
      async () => {
        sends++;
      },
    ),
    /已暂停或取消/,
  );
  assert.equal(sends, 0);
  assert.equal(h.run().activeOperationId, worker.id);
});

test("an ordered fallback continues the same task and a later task reuses that model", async (t) => {
  const h = await harness(fallbacks());
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.engine.control(h.id, "note", undefined, { feedback: "保留原有缓存" });
  await h.complete({
    ...plan,
    tasks: [
      plan.tasks[0],
      { ...plan.tasks[0], id: "task-2", title: "复测", description: "复测并记录" },
    ],
  });
  const worker = await h.until("execute");
  h.agents.activities.set(worker.agentId!, {
    text: '[Thought] hidden\napi_key=super-secret\nsk-supersecretvalue\nmcpServers: {"token":"abc"}\n[Assistant] npm test passed in the report',
  });
  const cwd = h.run().cwd;
  const prepares = h.repository.prepares;
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const next = await h.until("execute");
  assert.notEqual(next.id, worker.id);
  assert.equal(next.taskId, "task-1");
  assert.equal(next.profileId, "worker");
  assert.equal(next.executionModel?.provider, "vendor-c/model-c");
  assert.equal(next.executionModel?.thinkingOptionId, "high");
  assert.equal(h.run().tasks[0].reworks, 0);
  assert.equal(h.run().planVersion ?? 1, 1);
  assert.equal(h.run().tasks[0].profileId, "worker");
  assert.equal(h.run().executionModels?.worker.provider, "vendor-c/model-c");
  const created = h.agents.created.at(-1)!;
  assert.equal(created.profile.provider, "vendor-c/model-c");
  assert.equal(created.profile.thinkingOptionId, "high");
  assert.equal(created.profile.instructions, "保留现有接口");
  assert.match(next.prompt, /model handoff after quota exhaustion/);
  assert.match(next.prompt, /实现新功能/);
  assert.match(next.prompt, /保留现有接口/);
  assert.match(next.prompt, /保留原有缓存/);
  assert.match(next.prompt, /src\/api.ts/);
  assert.match(next.prompt, /cannot count as passed/);
  assert.match(next.prompt, /\[redacted\]/);
  assert.doesNotMatch(next.prompt, /sk-supersecretvalue|\[Thought\]|mcpServers/);
  assert.match(next.prompt, /Missing: None/);
  assert.match(next.prompt, /Truncated: No/);
  assert.equal(h.run().cwd, cwd);
  assert.equal(h.repository.prepares, prepares);
  assert.equal(h.repository.discarded.length, 0);
  assert.equal(h.run().operations[1].superseded, true);
  assert.equal(
    workflowEvidence(h.run()).operations.find((op) => op.operationId === next.id)?.executionModel
      ?.provider,
    "vendor-c/model-c",
  );
  await h.complete(result);
  const second = await h.until("execute");
  assert.equal(second.taskId, "task-2");
  assert.equal(second.agentId, next.agentId);
  assert.equal(second.executionModel?.provider, "vendor-c/model-c");
  assert.notEqual(second.agentId, worker.agentId);
});

test("invalid and exhausted fallbacks are skipped once and then wait for the user", async (t) => {
  const h = await harness(fallbacks());
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  h.agents.invalidModels.add("vendor-c/model-c");
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const first = await h.until("execute");
  assert.equal(first.executionModel?.provider, "vendor-d/model-d");
  assert.equal(
    h.agents.created.some((agent) => agent.profile.provider === "vendor-c/model-c"),
    false,
  );
  fail(h.agents, first.agentId!, QUOTA);
  await h.engine.tick();
  const run = h.run();
  assert.equal(run.control, "needs_attention");
  assert.equal(run.executionRelay?.status, "blocked");
  assert.equal(run.executionRelay?.manual, true);
  assert.match(run.message, /备用模型额度也已耗尽|备用模型不可用/);
  const created = h.agents.created.length;
  await h.engine.tick();
  assert.equal(h.agents.created.length, created);
  assert.equal(h.run().activeOperationId, first.id);
});

test("provider failures that are not quota do not switch models", async (t) => {
  const errors = [
    "401 Unauthorized",
    "insufficient_quota",
    "insufficient credit balance",
    "400 invalid request",
    "429 Too Many Requests: rate limit exceeded",
    "RESOURCE_EXHAUSTED",
    "tool call failed: npm test exited 1",
  ];
  for (const error of errors) {
    const { h, worker } = await executing(fallbacks());
    t.onTestFinished(() => h.cleanup());
    const created = h.agents.created.length;
    fail(h.agents, worker.agentId!, error);
    await h.engine.tick();
    assert.equal(h.run().control, "needs_attention", error);
    assert.equal(h.run().executionRelay, undefined, error);
    assert.equal(h.run().autoRetry, undefined, error);
    assert.equal(h.agents.created.length, created, error);
  }
});

test("network failures still retry in place when fallbacks exist", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, 'request failed: Post "https://example.invalid": EOF');
  await h.engine.tick();
  assert.equal(h.run().control, "running");
  assert.match(h.run().message, /自动重试/);
  assert.equal(h.run().executionRelay, undefined);
  h.elapse(31000);
  await h.engine.tick();
  const retried = await h.until("execute");
  assert.notEqual(retried.id, worker.id);
  assert.equal(retried.executionModel?.provider ?? "vendor-b/model-b", "vendor-b/model-b");
  assert.equal(
    h.agents.created.some((agent) => agent.profile.provider === "vendor-c/model-c"),
    false,
  );
});

test("ordinary assistant text and a plan quota error do not switch the executor", async (t) => {
  const h = await harness(fallbacks());
  t.onTestFinished(() => h.cleanup());
  const planner = await h.until("plan");
  h.agents.states.set(planner.agentId!, {
    status: "idle",
    seen: true,
    output: `API error (attempt 1): ${QUOTA}`,
  });
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.equal(h.run().executionRelay, undefined);
  assert.equal(h.agents.created.length, 1);
  await h.engine.control(h.id, "retry");
  const replanned = await h.until("plan");
  assert.notEqual(replanned.id, planner.id);
  await h.complete(plan);
  const worker = await h.until("execute");
  h.agents.states.set(worker.agentId!, {
    status: "idle",
    seen: true,
    output: "The notes mention that quota reached is unrelated.",
  });
  await h.engine.tick();
  const nudged = await h.until("execute");
  assert.equal(nudged.agentId, worker.agentId);
  assert.equal(h.run().executionRelay, undefined);
  assert.match(nudged.prompt, /invalid format/);
});

test("a manual switch is idempotent and rejects stale, canceled or non-quota requests", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  const model = { provider: "vendor-c/model-c", thinkingOptionId: "low" };
  await assert.rejects(
    h.engine.switchExecutor(h.id, {
      expectedOperationId: worker.id,
      token: 1,
      requestId: "too-soon",
      model,
    }),
    /不能换模型/,
  );
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const relay = h.run().executionRelay!;
  const request = {
    expectedOperationId: worker.id,
    token: relay.token,
    requestId: "switch-1",
    model,
  };
  await assert.rejects(
    h.engine.switchExecutor(h.id, { ...request, token: relay.token + 9 }),
    /过期/,
  );
  await assert.rejects(
    h.engine.switchExecutor(h.id, { ...request, expectedOperationId: "other-op" }),
    /只有额度耗尽/,
  );
  const created = h.agents.created.length;
  const [first, second] = await Promise.all([
    h.engine.switchExecutor(h.id, request),
    h.engine.switchExecutor(h.id, request),
  ]);
  assert.equal(first.operationId, second.operationId);
  assert.notEqual(first.operationId, worker.id);
  const raced = await Promise.allSettled([
    h.engine.switchExecutor(h.id, { ...request, requestId: "switch-2" }),
    h.engine.switchExecutor(h.id, request),
  ]);
  assert.equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(raced.filter((entry) => entry.status === "rejected").length, 1);
  const switched = await h.until("execute");
  assert.equal(switched.id, first.operationId);
  assert.equal(switched.executionModel?.thinkingOptionId, "low");
  assert.equal(h.agents.created.length, created + 1);
  assert.equal((await h.engine.switchExecutor(h.id, request)).operationId, switched.id);
  assert.equal(h.agents.created.length, created + 1);
  await assert.rejects(h.engine.submit(h.id, worker.taskId!, worker.id, result), /已经结束/);
  assert.equal(h.run().tasks[0].status, "executing");
  const done = h.run();
  done.phase = "awaiting_acceptance";
  h.store.save(done);
  await assert.rejects(
    h.engine.switchExecutor(h.id, { ...request, requestId: "switch-3" }),
    /验收/,
  );
  done.phase = "completed";
  h.store.save(done);
  await assert.rejects(
    h.engine.switchExecutor(h.id, { ...request, requestId: "switch-4" }),
    /已结束/,
  );
});

test("a manual switch after the time budget ran out continues on a fresh budget", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const blocked = h.run();
  blocked.budgetUsedMs = blocked.settings.runTimeoutMs;
  h.store.save(blocked);
  const { operationId } = await h.engine.switchExecutor(h.id, {
    expectedOperationId: worker.id,
    token: blocked.executionRelay!.token,
    requestId: "switch-after-budget",
    model: { provider: "vendor-c/model-c", thinkingOptionId: "low" },
  });
  const switched = await h.until("execute");
  assert.equal(switched.id, operationId);
  await h.engine.tick();
  assert.equal(h.run().control, "running");
});

test("stop failure does not start a replacement, and the same request can retry", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const token = h.run().executionRelay!.token;
  const request = {
    expectedOperationId: worker.id,
    token,
    requestId: "retry-stop",
    model: { provider: "vendor-c/model-c", thinkingOptionId: "low" },
  };
  h.agents.stopError = "AI 会话拒绝停止当前轮次";
  const created = h.agents.created.length;
  await assert.rejects(h.engine.switchExecutor(h.id, request), /未能停止/);
  assert.equal(h.agents.created.length, created);
  assert.equal(h.run().executionRelay?.status, "failed");
  h.agents.stopError = undefined;
  h.agents.holdInFlight.add(worker.agentId!);
  await assert.rejects(h.engine.switchExecutor(h.id, request), /未能停止/);
  assert.equal(h.agents.created.length, created);
  h.agents.holdInFlight.delete(worker.agentId!);
  const switched = await h.engine.switchExecutor(h.id, request);
  const next = await h.until("execute");
  assert.equal(next.id, switched.operationId);
  assert.equal(h.agents.created.length, created + 1);
  assert.equal(next.profileId, "worker");
  assert.equal(h.run().branch, `director/${h.id}`);
});

test("pause and cancel win before a replacement session is created", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  const relay: ExecutionRelay = {
    status: "stopping",
    source: "automatic",
    operationId: worker.id,
    taskId: worker.taskId!,
    profileId: worker.profileId,
    agentId: worker.agentId,
    errorClass: "quota",
    message: QUOTA,
    attempted: [{ provider: "vendor-b/model-b" }],
    manual: true,
    token: 4,
    at: 1,
    target: { provider: "vendor-c/model-c", thinkingOptionId: "high" },
  };
  const paused = h.run();
  paused.control = "paused";
  paused.executionRelay = relay;
  h.store.save(paused);
  const created = h.agents.created.length;
  await h.engine.tick();
  assert.equal(h.agents.created.length, created);
  assert.equal(h.run().activeOperationId, worker.id);
  await h.engine.control(h.id, "resume");
  await h.engine.tick();
  const next = await h.until("execute");
  assert.equal(next.executionModel?.provider, "vendor-c/model-c");
  assert.equal(h.agents.created.length, created + 1);
  const again = h.run();
  again.control = "canceled";
  again.executionRelay = { ...relay, operationId: next.id, agentId: next.agentId };
  again.activeOperationId = next.id;
  h.store.save(again);
  await h.engine.tick();
  assert.equal(h.agents.created.length, created + 1);
  assert.equal(h.run().activeOperationId, next.id);
});

test("a submitted result is kept and a late result from the old session cannot finish the new one", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  await h.engine.submit(h.id, worker.taskId!, worker.id, result);
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  assert.equal(h.run().tasks[0].status, "executed");
  assert.equal(h.run().executionRelay, undefined);
  assert.equal(
    h.agents.created.filter((agent) => agent.profile.provider === "vendor-c/model-c").length,
    0,
  );
  const blocked = await executing(fallbacks());
  t.onTestFinished(() => blocked.h.cleanup());
  fail(blocked.h.agents, blocked.worker.agentId!, QUOTA);
  await blocked.h.engine.tick();
  const next = await blocked.h.until("execute");
  await assert.rejects(
    blocked.h.engine.submit(blocked.h.id, blocked.worker.taskId!, blocked.worker.id, result),
    /已经结束/,
  );
  assert.equal(blocked.h.run().activeOperationId, next.id);
  assert.equal(blocked.h.run().tasks[0].status, "executing");
});

test("a preparing relay survives restart, ignores count limits and obeys the time budget", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  const handoff = "交接包是进度证据 HANDOFF-MARKER";
  const prepared: ExecutionRelay = {
    status: "preparing",
    source: "automatic",
    operationId: worker.id,
    taskId: worker.taskId!,
    profileId: worker.profileId,
    agentId: worker.agentId,
    errorClass: "quota",
    message: QUOTA,
    attempted: [{ provider: "vendor-b/model-b" }],
    manual: true,
    token: 5,
    at: 1,
    target: { provider: "vendor-c/model-c", thinkingOptionId: "high" },
    handoff,
  };
  const run = h.run();
  run.executionRelay = prepared;
  h.store.save(run);
  const cwd = run.cwd;
  const created = h.agents.created.length;
  await h.restart();
  await h.engine.tick();
  const next = await h.until("execute");
  assert.match(next.prompt, /HANDOFF-MARKER/);
  assert.equal(h.agents.created.length, created + 1);
  assert.equal(h.run().cwd, cwd);
  assert.equal(h.repository.prepares, 1);

  const limited = h.run();
  limited.executionRelay = { ...prepared, operationId: next.id, agentId: next.agentId };
  limited.activeOperationId = next.id;
  limited.settings.maxAttempts = limited.operations.length;
  h.store.save(limited);
  await h.engine.tick();
  await h.until("execute");
  assert.equal(h.run().control, "running");
  assert.equal(h.run().executionRelay, undefined);
  assert.equal(h.agents.created.length, created + 2);

  const timed = await executing();
  t.onTestFinished(() => timed.h.cleanup());
  const timedRun = timed.h.run();
  timedRun.executionRelay = {
    ...prepared,
    operationId: timed.worker.id,
    taskId: timed.worker.taskId!,
    agentId: timed.worker.agentId,
  };
  timedRun.budgetUsedMs = timedRun.settings.runTimeoutMs;
  timedRun.runningSince = undefined;
  timed.h.store.save(timedRun);
  const before = timed.h.agents.created.length;
  await timed.h.engine.tick();
  assert.equal(timed.h.agents.created.length, before);
  assert.equal(timed.h.run().executionRelay?.reason, "时间预算已耗尽");
  assert.notEqual(timed.h.run().control, "running");
});

test("rework after a handoff keeps the replacement model and a manual retry does not", async (t) => {
  const h = await harness(fallbacks());
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const handed = await h.until("execute");
  await h.complete(result);
  await h.until("final");
  await h.complete(review(true, "changes_requested"));
  const reworked = await h.until("execute");
  assert.equal(reworked.agentId, handed.agentId);
  assert.equal(reworked.executionModel?.provider, "vendor-c/model-c");
  assert.equal(h.run().tasks[0].reworks, 1);
  assert.equal(h.run().tasks[0].profileId, "worker");

  const retry = await executing();
  t.onTestFinished(() => retry.h.cleanup());
  fail(retry.h.agents, retry.worker.agentId!, QUOTA);
  await retry.h.engine.tick();
  await retry.h.engine.control(retry.h.id, "retry");
  const retried = await retry.h.until("execute");
  assert.equal(retried.executionModel?.provider, "vendor-b/model-b");
  assert.equal(retry.h.run().executionRelay, undefined);
  assert.equal(
    retry.h.agents.created.some((agent) => agent.profile.provider === "vendor-c/model-c"),
    false,
  );
});

test("assistant API errors on an execute turn use the same handoff entry", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  h.agents.states.set(worker.agentId!, {
    status: "idle",
    seen: true,
    output: `API error (attempt 1): ${QUOTA}`,
  });
  await h.engine.tick();
  const next = await h.until("execute");
  assert.equal(next.executionModel?.provider, "vendor-c/model-c");
  assert.notEqual(next.agentId, worker.agentId);
});

function inflight(agents: FakeAgents, agentId: string, error: string, output = "") {
  agents.holdInFlight.add(agentId);
  agents.states.set(agentId, {
    status: "error",
    seen: true,
    output,
    error,
    ownership: { inFlight: true, pendingPermissions: 0, lifecycle: "error" },
  });
}

async function pendingExecute(h: Awaited<ReturnType<typeof harness>>) {
  await h.until("plan");
  await h.complete(plan);
  for (let attempt = 0; attempt < 10; attempt++) {
    const op = h.op();
    if (op?.kind === "execute" && op.state === "pending") return op;
    await h.engine.tick();
  }
  throw new Error("execute was not pending");
}

async function readyExecute(h: Awaited<ReturnType<typeof harness>>) {
  const pending = await pendingExecute(h);
  await h.engine.tick();
  const ready = h.op();
  if (ready?.kind !== "execute" || ready.state !== "ready")
    throw new Error(`execute was not ready: ${ready?.state}`);
  return ready ?? pending;
}

test("ordinary retry does not start a writer while the old session is still running", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  inflight(h.agents, worker.agentId!, QUOTA);
  const created = h.agents.created.length;
  const sent = h.agents.sent.length;
  await h.engine.tick();
  const relay = h.run().executionRelay!;
  assert.equal(relay.status, "failed");
  assert.equal(h.agents.created.length, created);
  assert.equal(h.agents.sent.length, sent);
  await assert.rejects(h.engine.control(h.id, "retry"), /仍在执行/);
  assert.equal(h.agents.created.length, created);
  assert.equal(h.agents.sent.length, sent);
  assert.equal(h.run().executionRelay?.status, "failed");
  assert.equal(h.run().executionRelay?.token, relay.token);
  h.agents.holdInFlight.delete(worker.agentId!);
  h.agents.states.set(worker.agentId!, {
    status: "error",
    seen: true,
    output: "",
    error: QUOTA,
    ownership: { inFlight: false, pendingPermissions: 0, lifecycle: "error" },
  });
  await h.engine.control(h.id, "retry");
  const next = await h.until("execute");
  assert.equal(next.executionModel?.provider ?? "vendor-b/model-b", "vendor-b/model-b");
  assert.notEqual(next.agentId, worker.agentId);
  assert.equal(h.agents.created.length, created + 1);
  assert.equal(h.agents.sent.length, sent + 1);
  assert.equal(h.agents.sent.at(-1)?.agentId, next.agentId);
  assert.equal(h.run().executionRelay, undefined);
});

test("a carried session that is still running is not unbound", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete({
    ...plan,
    tasks: [
      plan.tasks[0],
      { ...plan.tasks[0], id: "task-2", title: "复测", description: "复测并记录" },
    ],
  });
  const first = await h.until("execute");
  await h.complete(result);
  inflight(h.agents, first.agentId!, QUOTA);
  const created = h.agents.created.length;
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.match(h.run().message, /仍在执行/);
  assert.equal(h.agents.created.length, created);
  assert.equal(h.op()?.agentId, first.agentId);
  assert.equal(h.op()?.taskId, "task-2");
});

test("a timeout does not replace a session that is still in flight", async (t) => {
  const h = await harness({ turnTimeoutMs: 1000 });
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  const created = h.agents.created.length;
  const sent = h.agents.sent.length;
  h.agents.holdInFlight.add(op.agentId!);
  h.elapse(1001);
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  assert.equal(h.agents.created.length, created);
  assert.equal(h.agents.sent.length, sent);
  h.agents.holdInFlight.delete(op.agentId!);
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.equal(h.agents.created.length, created);
  assert.equal(h.agents.sent.length, sent);
});

test("a failed switch stays paused until an explicit resume", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const relay = h.run().executionRelay!;
  const request = {
    expectedOperationId: worker.id,
    token: relay.token,
    requestId: "pause-switch",
    model: { provider: "vendor-c/model-c", thinkingOptionId: "low" },
  };
  h.agents.stopError = "AI 会话拒绝停止当前轮次";
  await assert.rejects(h.engine.switchExecutor(h.id, request), /未能停止/);
  await h.engine.control(h.id, "pause");
  const created = h.agents.created.length;
  const sent = h.agents.sent.length;
  h.agents.stopError = undefined;
  await assert.rejects(h.engine.switchExecutor(h.id, request), /不能换模型/);
  await assert.rejects(
    h.engine.switchExecutor(h.id, { ...request, token: relay.token + 3 }),
    /过期/,
  );
  await assert.rejects(
    h.engine.switchExecutor(h.id, { ...request, expectedOperationId: "stale-op" }),
    /过期/,
  );
  assert.equal(h.run().control, "paused");
  assert.equal(h.agents.created.length, created);
  assert.equal(h.agents.sent.length, sent);
  await h.engine.control(h.id, "resume");
  assert.equal(h.run().control, "running");
  const switched = await h.engine.switchExecutor(h.id, request);
  const next = await h.until("execute");
  assert.equal(next.id, switched.operationId);
  assert.equal(h.agents.created.length, created + 1);
});

test("a valid result that arrives after quota is recovered instead of repeated", async (t) => {
  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  assert.equal(h.run().executionRelay?.status, "blocked");
  h.agents.states.set(worker.agentId!, {
    status: "idle",
    seen: true,
    output: JSON.stringify(result),
    ownership: { inFlight: false, pendingPermissions: 0, lifecycle: "idle" },
  });
  const created = h.agents.created.length;
  const request = {
    expectedOperationId: worker.id,
    token: h.run().executionRelay!.token,
    requestId: "recover-ready",
    model: { provider: "vendor-c/model-c", thinkingOptionId: "low" },
  };
  await h.engine.switchExecutor(h.id, request);
  assert.equal(h.run().tasks[0].status, "executed");
  assert.equal(h.run().operations.find((op) => op.id === worker.id)?.state, "done");
  assert.equal(h.agents.created.length, created);
  assert.equal(h.run().operations.filter((op) => op.kind === "execute").length, 1);
  await h.engine.tick();
  assert.equal(h.run().phase, "final_review");
});

test("a result that arrives while stopping is kept and an in-flight result waits", async (t) => {
  const during = await executing();
  t.onTestFinished(() => during.h.cleanup());
  fail(during.h.agents, during.worker.agentId!, QUOTA);
  await during.h.engine.tick();
  const created = during.h.agents.created.length;
  during.h.agents.stop = async (agentId: string) => {
    during.h.agents.stopped.push(agentId);
    during.h.agents.states.set(agentId, {
      status: "idle",
      seen: true,
      output: JSON.stringify(result),
      ownership: { inFlight: false, pendingPermissions: 0, lifecycle: "idle" },
    });
  };
  await during.h.engine.switchExecutor(during.h.id, {
    expectedOperationId: during.worker.id,
    token: during.h.run().executionRelay!.token,
    requestId: "during-stop",
    model: { provider: "vendor-c/model-c", thinkingOptionId: "low" },
  });
  assert.equal(during.h.run().tasks[0].status, "executed");
  assert.equal(during.h.agents.created.length, created);
  assert.equal(during.h.run().phase, "executing");
  await during.h.engine.tick();
  assert.equal(during.h.run().phase, "final_review");

  const { h, worker } = await executing();
  t.onTestFinished(() => h.cleanup());
  await h.engine.submit(h.id, worker.taskId!, worker.id, result);
  inflight(h.agents, worker.agentId!, QUOTA, JSON.stringify(result));
  const before = h.agents.created.length;
  await h.engine.tick();
  assert.equal(h.run().tasks[0].status, "executing");
  assert.equal(h.run().phase, "executing");
  assert.equal(h.agents.created.length, before);
  const request = {
    expectedOperationId: worker.id,
    token: h.run().executionRelay!.token,
    requestId: "inflight-result",
    model: { provider: "vendor-c/model-c", thinkingOptionId: "low" },
  };
  await assert.rejects(h.engine.switchExecutor(h.id, request), /未能停止/);
  assert.equal(h.run().tasks[0].status, "executing");
  assert.equal(h.agents.created.length, before);
  h.agents.holdInFlight.delete(worker.agentId!);
  await h.engine.switchExecutor(h.id, request);
  assert.equal(h.run().tasks[0].status, "executed");
  assert.equal(h.run().operations.find((op) => op.id === worker.id)?.state, "done");
  assert.equal(h.agents.created.length, before);
  assert.equal(h.run().phase, "executing");
  await h.engine.tick();
  assert.equal(h.run().phase, "final_review");
});

test("assistant text cannot invent or hide a provider quota failure", async (t) => {
  const chatter = await executing(fallbacks());
  t.onTestFinished(() => chatter.h.cleanup());
  chatter.h.agents.states.set(chatter.worker.agentId!, {
    status: "idle",
    seen: true,
    output: "Debug example: [System Error] quota reached while parsing api_key and 400 billing",
  });
  await chatter.h.engine.tick();
  assert.equal(chatter.h.run().executionRelay, undefined);
  const nudged = await chatter.h.until("execute");
  assert.equal(nudged.agentId, chatter.worker.agentId);
  assert.match(nudged.prompt, /invalid format/);

  const masked = await executing(fallbacks());
  t.onTestFinished(() => masked.h.cleanup());
  fail(
    masked.h.agents,
    masked.worker.agentId!,
    QUOTA,
    "updated the api_key parsing and returned 400 billing\ntool call failed",
  );
  await masked.h.engine.tick();
  const handed = await masked.h.until("execute");
  assert.equal(handed.executionModel?.provider, "vendor-c/model-c");

  for (const error of ["401 Unauthorized", "insufficient credit balance", "tool call failed"]) {
    const { h, worker } = await executing(fallbacks());
    t.onTestFinished(() => h.cleanup());
    fail(h.agents, worker.agentId!, error, "Individual quota reached");
    await h.engine.tick();
    assert.equal(h.run().executionRelay, undefined, error);
    assert.equal(h.run().control, "needs_attention", error);
  }
});

test("quota thrown by create or send uses the same handoff and leaves uncertainty alone", async (t) => {
  const sent = await harness(fallbacks());
  t.onTestFinished(() => sent.cleanup());
  await readyExecute(sent);
  sent.agents.pendingSendErrors.push({ message: QUOTA }, { message: QUOTA });
  const switched = await sent.until("execute");
  assert.equal(switched.executionModel?.provider, "vendor-d/model-d");
  assert.equal(
    sent.agents.created.filter((agent) => agent.profile.provider === "vendor-c/model-c").length,
    1,
  );

  const manual = await harness();
  t.onTestFinished(() => manual.cleanup());
  await readyExecute(manual);
  const created = manual.agents.created.length;
  manual.agents.pendingSendErrors.push({ message: QUOTA });
  await manual.engine.tick();
  assert.equal(manual.run().executionRelay?.status, "blocked");
  assert.equal(manual.run().executionRelay?.manual, true);
  assert.match(manual.run().message, /换模型继续/);
  assert.equal(manual.agents.created.length, created);

  for (const message of ["401 Unauthorized", "insufficient credit balance"]) {
    const blocked = await harness(fallbacks());
    t.onTestFinished(() => blocked.cleanup());
    await readyExecute(blocked);
    const before = blocked.agents.created.length;
    blocked.agents.pendingSendErrors.push({ message });
    await blocked.engine.tick();
    assert.equal(blocked.run().executionRelay, undefined, message);
    assert.equal(blocked.run().control, "needs_attention", message);
    assert.equal(blocked.agents.created.length, before, message);
    await blocked.engine.tick();
    assert.equal(blocked.agents.created.length, before, message);
  }

  const network = await harness(fallbacks());
  t.onTestFinished(() => network.cleanup());
  await readyExecute(network);
  network.agents.pendingSendErrors.push({
    message: 'request failed: Post "https://example.invalid": EOF',
  });
  await network.engine.tick();
  assert.equal(network.run().control, "running");
  assert.equal(network.run().executionRelay, undefined);
  assert.match(network.run().message, /自动重试/);

  const createdQuota = await harness(fallbacks());
  t.onTestFinished(() => createdQuota.cleanup());
  await pendingExecute(createdQuota);
  createdQuota.agents.pendingCreateErrors.push({ message: QUOTA });
  const createdNext = await createdQuota.until("execute");
  assert.equal(createdNext.executionModel?.provider, "vendor-c/model-c");
  assert.equal(
    createdQuota.agents.created.some((agent) => agent.profile.provider === "vendor-b/model-b"),
    false,
  );

  const busyCreate = await harness(fallbacks());
  t.onTestFinished(() => busyCreate.cleanup());
  await pendingExecute(busyCreate);
  const busyBefore = busyCreate.agents.created.length;
  busyCreate.agents.pendingCreateErrors.push({ message: QUOTA, inFlight: true });
  await busyCreate.engine.tick();
  assert.equal(busyCreate.run().executionRelay?.status, "failed");
  assert.equal(busyCreate.agents.created.length, busyBefore + 1);
  assert.equal(
    busyCreate.agents.created.some((agent) => agent.profile.provider === "vendor-c/model-c"),
    false,
  );

  const ambiguous = await harness(fallbacks());
  t.onTestFinished(() => ambiguous.cleanup());
  await pendingExecute(ambiguous);
  const ambiguousBefore = ambiguous.agents.created.length;
  ambiguous.agents.pendingCreateErrors.push({ message: QUOTA });
  ambiguous.agents.ambiguousFinds = 1;
  await ambiguous.engine.tick();
  assert.equal(ambiguous.run().executionRelay, undefined);
  assert.match(ambiguous.run().message, /结果不明确/);
  assert.equal(ambiguous.agents.created.length, ambiguousBefore);
  await ambiguous.engine.tick();
  assert.equal(ambiguous.agents.created.length, ambiguousBefore);

  const unseen = await harness(fallbacks());
  t.onTestFinished(() => unseen.cleanup());
  await readyExecute(unseen);
  const unseenCreated = unseen.agents.created.length;
  const unseenSent = unseen.agents.sent.length;
  unseen.agents.successfulInspects = 0;
  unseen.agents.inspectThrowsAfter = 1;
  unseen.agents.pendingSendErrors.push({ message: QUOTA });
  await unseen.engine.tick();
  assert.equal(unseen.run().executionRelay, undefined);
  assert.match(unseen.run().message, /无法确认/);
  assert.equal(unseen.agents.created.length, unseenCreated);
  assert.equal(unseen.agents.sent.length, unseenSent);
  await unseen.engine.tick();
  assert.equal(unseen.agents.sent.length, unseenSent);

  const flying = await harness(fallbacks());
  t.onTestFinished(() => flying.cleanup());
  await readyExecute(flying);
  const flyingCreated = flying.agents.created.length;
  flying.agents.pendingSendErrors.push({ message: QUOTA, inFlight: true });
  await flying.engine.tick();
  assert.equal(flying.run().executionRelay?.status, "failed");
  assert.match(flying.run().message, /未能停止/);
  assert.doesNotMatch(flying.run().message, /无法确认/);
  assert.equal(flying.agents.created.length, flyingCreated);

  const planner = await harness(fallbacks());
  t.onTestFinished(() => planner.cleanup());
  planner.agents.pendingCreateErrors.push({ message: QUOTA });
  for (let attempt = 0; attempt < 5 && planner.run().control === "running"; attempt++)
    await planner.engine.tick();
  assert.equal(planner.run().executionRelay, undefined);
  assert.equal(planner.run().control, "needs_attention");
  assert.equal(planner.op()?.kind, "plan");
});

test("handoff reports clipped evidence and removes credential fields", async (t) => {
  const secret = '{"api_key":"DEMO_SECRET_VALUE","password":"DEMO_PASSWORD_VALUE"}';
  const nested = 'mcpServers: {"nested":{"api_key":"DEMO_SECRET_VALUE"}}';
  assert.equal(redactHandoffText(secret).includes("DEMO_SECRET_VALUE"), false);
  assert.equal(redactHandoffText(secret).includes("DEMO_PASSWORD_VALUE"), false);
  assert.equal(redactHandoffText("api_key=DEMO_SECRET_VALUE").includes("DEMO_SECRET_VALUE"), false);
  const redacted = redactHandoffText(nested);
  assert.equal(redacted.includes("DEMO_SECRET_VALUE"), false);
  assert.equal(redacted.includes("mcpServers"), false);
  const bounded = boundHandoffText(
    `${"y".repeat(HANDOFF_ACTIVITY_LIMIT)}\n${secret}`,
    HANDOFF_ACTIVITY_LIMIT,
  );
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.text.includes("DEMO_SECRET_VALUE"), false);

  const operationId = "op-clip";
  const marker = {
    type: "user_message" as const,
    text: `[paseo-director:${operationId}] task`,
    clientMessageId: operationId,
  };
  const clipped = handoffTimelineEvidence(
    [
      marker,
      ...Array.from({ length: 41 }, (_, index) => ({
        type: "assistant_message" as const,
        text: `step ${index} npm test`,
        messageId: `m-${index}`,
      })),
    ],
    operationId,
  );
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.missing, false);
  assert.match(clipped.text, /step 40 npm test/);
  assert.doesNotMatch(clipped.text, /step 0 npm test/);
  const small = handoffTimelineEvidence(
    [marker, { type: "assistant_message", text: "npm test", messageId: "only" }],
    operationId,
  );
  assert.equal(small.truncated, false);
  assert.equal(small.missing, false);

  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  h.agents.activities.set(worker.agentId!, {
    text: `npm test reported\n${secret}\n${nested}`,
    truncated: true,
    missing: false,
  });
  h.repository.changes = {
    paths: ["src/api.ts"],
    diff: "diff --git a/src/api.ts\n+export const api = 1;\n",
    missing: true,
    truncated: true,
    pathCount: 90,
  };
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const next = await h.until("execute");
  assert.match(next.prompt, /npm test reported/);
  assert.match(next.prompt, /Truncated: Yes/);
  assert.match(next.prompt, /Missing: Workspace changes/);
  assert.doesNotMatch(next.prompt, /Missing: None/);
  assert.equal(next.prompt.includes("DEMO_SECRET_VALUE"), false);
  assert.equal(next.prompt.includes("DEMO_PASSWORD_VALUE"), false);
  assert.equal(next.prompt.includes("mcpServers"), false);
  assert.match(next.prompt, /保留现有接口/);
});

test("an error example does not replace the execution session", async (t) => {
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  h.agents.states.set(worker.agentId!, {
    status: "idle",
    seen: true,
    output: `Example handled by the parser:\n\`\`\`text\n[System Error] ${QUOTA}\n\ncode: RESOURCE_EXHAUSTED\n\`\`\``,
  });
  const created = h.agents.created.length;
  await h.engine.tick();
  assert.equal(h.run().executionRelay, undefined);
  assert.equal(h.agents.created.length, created);
  assert.equal(h.run().executionModels?.worker, undefined);
  const correction = await h.until("execute");
  assert.equal(correction.agentId, worker.agentId);
  assert.equal(correction.formatRetries, 1);
});

test("handoff removes complete credentials and nested MCP configuration before sending", async (t) => {
  const fixtures = [
    "Authorization: Basic DEMO_BASIC_CREDENTIAL",
    "Authorization: Bearer DEMO_BEARER_CREDENTIAL",
    "X-Api-Key: DEMO_HEADER_CREDENTIAL",
    "OPENAI_API_KEY=DEMO_ENV_CREDENTIAL",
    '{"client_secret":"DEMO_CLIENT_CREDENTIAL","privateKey":"DEMO_PRIVATE_CREDENTIAL"}',
    "https://user:DEMO_URL_CREDENTIAL@example.invalid/api?access_token=DEMO_QUERY_CREDENTIAL&view=summary",
    'mcpServers: {"remote":{"note":"brace } and escaped \\" quote","env":{"CUSTOM":"DEMO_MCP_CREDENTIAL"}}}',
    'mcpServers: [{"url":"https://example.invalid","env":{"CUSTOM":"DEMO_ARRAY_CREDENTIAL"}}]',
    "mcpServers:\n  remote:\n    env:\n      CUSTOM: DEMO_YAML_CREDENTIAL\nnext: keep this report",
    'mcpServers:\n {"remote":{"env":{"CUSTOM":"DEMO_MULTILINE_CREDENTIAL"}}}\nnext: keep this report',
    '{"client_secret":\n "DEMO_MULTILINE_SECRET_CREDENTIAL"}',
    'mcpServers: {"remote":{"note":"DEMO_UNCLOSED_CREDENTIAL',
    "-----BEGIN PRIVATE KEY-----\nDEMO_PEM_CREDENTIAL\n-----END PRIVATE KEY-----",
  ];
  for (const fixture of fixtures) {
    assert.doesNotMatch(redactHandoffText(fixture), /DEMO_[A-Z_]+CREDENTIAL/, fixture);
  }
  assert.match(redactHandoffText(fixtures[8]), /next: keep this report/);
  assert.match(redactHandoffText(fixtures[9]), /next: keep this report/);
  const completeFixtures = fixtures.filter(
    (fixture) => !fixture.includes("DEMO_UNCLOSED_CREDENTIAL"),
  );
  const { h, worker } = await executing(fallbacks());
  t.onTestFinished(() => h.cleanup());
  h.agents.activities.set(worker.agentId!, { text: completeFixtures.join("\n") });
  h.repository.changes = {
    paths: ["src/api.ts"],
    diff: completeFixtures
      .map((fixture) =>
        fixture
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n"),
      )
      .join("\n"),
  };
  fail(h.agents, worker.agentId!, QUOTA);
  await h.engine.tick();
  const next = await h.until("execute");
  assert.doesNotMatch(next.prompt, /DEMO_[A-Z_]+CREDENTIAL/);
  assert.match(next.prompt, /src\/api.ts/);
  assert.match(next.prompt, /redacted/);
});
