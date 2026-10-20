import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { harness, plan, result, review, settings, reviewerSettings } from "./test-utils/harness.js";
import {
  profileForTask,
  validatePlan,
  parseOutput,
  canResumeRun,
  awaitingAcceptance,
  finalAcceptance,
} from "@getpaseo/protocol/collaboration/schema";
import {
  CollaborationGateway,
  inspectMessages,
  hasRepeatedShellCalls,
  profileCreateMode,
  type CollaborationHost,
} from "./gateway.js";
import { buildPrompt } from "./prompts.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { PiHistoryMapper } from "../agent/providers/pi/history-mapper.js";

test("retry delivers diagnostic feedback after restart and retains it for review", async (t) => {
  const h = await harness(reviewerSettings(), "execute_review");
  t.onTestFinished(() => h.cleanup());
  await h.until("execute");
  await h.complete({ ...result, status: "blocked", summary: "Six service tests still fail" });
  const feedback = "Only abort the barrier on failure; verify the reimbursement flow.";
  await h.engine.control(h.id, "retry", undefined, { feedback });
  await h.restart();
  const next = await h.until("execute");
  assert.match(next.prompt, /Only abort the barrier on failure/);
  await h.complete(result);
  const final = await h.until("final");
  assert.match(final.prompt, /Only abort the barrier on failure/);
});

test("implementation blockers receive diagnostic review and carry findings into rework", async (t) => {
  const h = await harness(reviewerSettings());
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  await h.complete({
    ...result,
    status: "blocked",
    blocker: "implementation",
    summary: "Six service tests still fail",
    issues: ["Concurrent update aborts the barrier on success"],
  });
  assert.equal(h.run().control, "running");
  assert.equal(h.run().tasks[0].status, "reviewing");
  const diagnostic = await h.until("review");
  assert.match(diagnostic.prompt, /Diagnostic review/);
  assert.match(diagnostic.prompt, /Six service tests still fail/);
  await h.complete(review(false, "changes_requested"));
  const rework = await h.until("execute");
  assert.equal(rework.agentId, worker.agentId);
  assert.match(rework.prompt, /增加空值处理/);
  await h.complete(result);
  await h.until("final");
});

test("diagnostic review cannot approve an incomplete implementation", async (t) => {
  const h = await harness(reviewerSettings());
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete({ ...result, status: "blocked", blocker: "implementation" });
  await h.until("review");
  await h.complete(review());
  assert.equal(h.run().control, "needs_attention");
  assert.equal(h.run().tasks[0].status, "reviewing");
  assert.equal(h.run().userAcceptance, undefined);
  assert.match(h.run().message, /不能批准成果/);
});

test.each([undefined, "external", "user"])(
  "a %s blocker preserves the stopped task for explicit recovery",
  async (blocker) => {
    const h = await harness(reviewerSettings(), "execute_review");
    try {
      await h.until("execute");
      await h.complete({ ...result, status: "blocked", blocker });
      assert.equal(h.run().control, "needs_attention");
      const sent = h.agents.sent.length;
      await h.engine.tick();
      assert.equal(h.agents.sent.length, sent);
    } finally {
      h.cleanup();
    }
  },
);

function shellPollingRows(count = 12, intervalMs = 5000): AgentTimelineRow[] {
  const startedAt = Date.parse("2026-10-15T06:28:00Z");
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: new Date(startedAt).toISOString(),
      item: { type: "user_message", text: "[paseo-director:operation]\n实现进度卡片" },
    },
  ];
  for (let index = 0; index < count; index++) {
    rows.push({
      seq: index + 2,
      timestamp: new Date(startedAt + (index + 1) * intervalMs).toISOString(),
      item: {
        type: "tool_call",
        callId: `call-${index}`,
        name: "bash",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "rg 'failed' /tmp/e2e-progress.txt",
          output: "95:  1 failed\n",
          exitCode: 0,
        },
      },
    });
  }
  return rows;
}

test("display-only progress does not interrupt collection of an operation's result", () => {
  const noticeId = "chat-notice:progress";
  const notice = {
    type: "user_message" as const,
    clientMessageId: noticeId,
    text: `[paseo-director-chat:${noticeId}]\nCollaboration progress update.\n{"message":"Reviewing"}`,
  };
  const messages = inspectMessages(
    [
      { type: "user_message", clientMessageId: "operation", text: "Review" },
      { type: "assistant_message", text: "Checking code" },
      notice,
      { type: "assistant_message", text: "Approved" },
    ],
    "operation",
  );
  assert.deepEqual(messages, { seen: true, interrupted: false, output: "Checking code\nApproved" });
  const rows = shellPollingRows();
  rows.splice(2, 0, { seq: 100, timestamp: rows[1].timestamp, item: notice });
  assert.equal(hasRepeatedShellCalls(rows, "operation"), true);
});

describe("repeated shell results", () => {
  test("completed Pi bash results without an exit code still detect the captured polling loop", () => {
    const mapper = new PiHistoryMapper("pi");
    const rows = shellPollingRows();
    for (let index = 1; index < rows.length; index++) {
      const events = mapper.mapMessages([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `pi-call-${index}`,
              name: "bash",
              arguments: { command: "rg 'failed' /tmp/e2e-progress.txt" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: `pi-call-${index}`,
          toolName: "bash",
          content: [{ type: "text", text: "95:  1 failed\n" }],
        },
      ]);
      const completed = events.find(
        (event) => event.item.type === "tool_call" && event.item.status === "completed",
      );
      assert.ok(completed);
      rows[index] = { ...rows[index], item: completed.item };
    }
    assert.equal(hasRepeatedShellCalls(rows, "operation"), true);
  });
  test("recognizes rapid unchanged test-log polling, but not slow polling or a short burst", () => {
    assert.equal(hasRepeatedShellCalls(shellPollingRows(), "operation"), true);
    assert.equal(hasRepeatedShellCalls(shellPollingRows(11), "operation"), false);
    assert.equal(hasRepeatedShellCalls(shellPollingRows(12, 15_000), "operation"), false);
    assert.equal(hasRepeatedShellCalls(shellPollingRows(), "other-operation"), false);
  });
  test("changed output, command, directory, exit code or another tool breaks the loop", () => {
    for (const detail of [
      {
        type: "shell",
        command: "rg 'failed' /tmp/e2e-progress.txt",
        output: "1 passed\n",
        exitCode: 0,
      },
      {
        type: "shell",
        command: "cat /tmp/e2e-progress.txt",
        output: "95:  1 failed\n",
        exitCode: 0,
      },
      {
        type: "shell",
        command: "rg 'failed' /tmp/e2e-progress.txt",
        cwd: "/other",
        output: "95:  1 failed\n",
        exitCode: 0,
      },
      {
        type: "shell",
        command: "rg 'failed' /tmp/e2e-progress.txt",
        output: "95:  1 failed\n",
        exitCode: 1,
      },
      { type: "edit", filePath: "src/api.ts", newString: "fixed" },
    ] satisfies Array<Extract<AgentTimelineRow["item"], { type: "tool_call" }>["detail"]>) {
      const rows = shellPollingRows();
      rows[6].item = {
        type: "tool_call",
        callId: "changed",
        name: "bash",
        status: "completed",
        error: null,
        detail,
      };
      assert.equal(hasRepeatedShellCalls(rows, "operation"), false);
    }
  });
  test("running tool calls, unfinished results, duplicate call rows and user steering are not repetitions", () => {
    const running = shellPollingRows();
    running.splice(1, 0, {
      seq: 1,
      timestamp: running[0].timestamp,
      item: {
        type: "tool_call",
        callId: "live",
        name: "bash",
        status: "running",
        error: null,
        detail: { type: "shell", command: "npm run build" },
      },
    });
    assert.equal(hasRepeatedShellCalls(running, "operation"), false);
    const pending = shellPollingRows();
    pending[12].item = {
      type: "tool_call",
      callId: "pending",
      name: "bash",
      status: "running",
      error: null,
      detail: { type: "shell", command: "read_process", output: "Still running", exitCode: null },
    };
    assert.equal(hasRepeatedShellCalls(pending, "operation"), false);
    const duplicates = shellPollingRows();
    duplicates[12].item = duplicates[11].item;
    assert.equal(hasRepeatedShellCalls(duplicates, "operation"), false);
    const steered = shellPollingRows();
    steered.push({
      seq: 14,
      timestamp: steered[12].timestamp,
      item: { type: "user_message", text: "补充要求" },
    });
    assert.equal(hasRepeatedShellCalls(steered, "operation"), false);
  });
});
describe("explicit retry replaces failed sessions with the original profile after restart", () => {
  for (const kind of ["plan", "execute", "final"] as const) {
    for (const failedState of ["ready", "sent"] as const)
      test(`${kind}/${failedState}`, async (t) => {
        const h = await harness();
        t.onTestFinished(() => h.cleanup());
        if (kind !== "plan") {
          await h.until("plan");
          await h.complete(plan);
        }
        if (kind === "final") {
          await h.until("execute");
          await h.complete(result);
        }
        const original = await h.until(kind);
        const run = h.run(),
          op = run.operations.find((candidateOperation) => candidateOperation.id === original.id)!;
        op.state = failedState;
        if (failedState === "ready") {
          op.sentAt = undefined;
          op.deliveryConfirmedAt = undefined;
        }
        h.store.save(run);
        h.agents.states.set(original.agentId!, {
          status: "error",
          seen: failedState === "sent",
          output: "",
          error: "agent process exited",
        });
        await h.engine.tick();
        assert.equal(h.run().control, "needs_attention");
        const sends = h.agents.sent.length,
          creates = h.agents.created.length;
        await h.engine.tick();
        assert.equal(h.agents.sent.length, sends);
        await h.restart();
        await h.engine.control(h.id, "retry");
        await h.restart();
        const replacement = await h.until(kind);
        assert.notEqual(replacement.agentId, original.agentId);
        assert.notEqual(replacement.id, original.id);
        assert.equal(replacement.profileId, original.profileId);
        assert.deepEqual(
          h.agents.created.at(-1)!.profile,
          h.agents.created.find((a) => a.id === original.agentId)!.profile,
        );
        assert.equal(h.agents.created.length, creates + 1);
        assert.equal(h.agents.sent.length, sends + 1);
        assert.ok(replacement.sentAt);
        assert.ok(replacement.deliveryConfirmedAt);
        assert.match(replacement.prompt, /Do not repeat completed changes/);
        assert.equal(
          h.run().operations.find((candidateOperation) => candidateOperation.id === original.id)!
            .agentId,
          original.agentId,
        );
        assert.equal(
          h.run().operations.find((candidateOperation) => candidateOperation.id === original.id)!
            .state,
          "abandoned",
        );
        await h.complete(
          { plan, execute: result, review: review(true), final: review(true) }[kind],
        );
        assert.notEqual(h.run().control, "needs_attention");
      });
  }
});
describe("retry preserves unavailable main chats and refuses busy sessions", () => {
  for (const status of ["error", "missing", "running", "permission"] as const)
    test(status, async (t) => {
      const h = await harness();
      t.onTestFinished(() => h.cleanup());
      const op = await h.until("plan"),
        run = h.run();
      run.control = "needs_attention";
      run.chat = { mainAgentId: op.agentId! } as typeof run.chat;
      h.store.save(run);
      h.agents.states.set(op.agentId!, { status, seen: false, output: "" });
      await assert.rejects(h.engine.control(h.id, "retry"), /主会话不可用|仍在执行或等待权限/);
      assert.equal(h.agents.created.length, 1);
      assert.equal(h.run().activeOperationId, op.id);
      assert.equal(h.run().directorAgentId, op.agentId);
      assert.equal(h.run().control, "needs_attention");
    });
});
test("retry recovers an existing streamed plan without another AI call", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  for (let attempt = 0; attempt < 3; attempt++) {
    const op = await h.until("plan");
    h.agents.states.set(op.agentId!, {
      status: "idle",
      seen: true,
      output: '{"\nsummary":"broken"}',
    });
    await h.engine.tick();
  }
  assert.equal(h.run().control, "needs_attention");
  const op = h.op()!,
    sent = h.agents.sent.length;
  const output = inspectMessages(
    [
      { type: "user_message", text: op.prompt },
      ...Array.from(JSON.stringify(plan), (text) => ({
        type: "assistant_message" as const,
        messageId: "final",
        text,
      })),
    ],
    op.id,
  );
  h.agents.states.set(op.agentId!, { status: "idle", ...output });
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().phase, "executing");
  assert.deepEqual(h.run().plan, plan);
  assert.equal(h.agents.sent.length, sent);
  assert.equal(h.run().operations.length, 3);
  await h.until("execute");
  await h.complete(result);
  await h.until("final");
  await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance");
});
test("quota failure in assistant output stops automatic format retries", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.agents.states.set(op.agentId!, {
    status: "idle",
    seen: true,
    output:
      "API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 166h36m1s.",
  });
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.match(h.run().message, /RESOURCE_EXHAUSTED/);
  assert.equal(h.run().operations.length, 1);
  assert.equal(h.agents.sent.length, 1);
  await h.engine.tick();
  assert.equal(h.agents.sent.length, 1);
});
test("recovering a valid plan still honors the user's approval setting", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan"),
    run = h.run();
  run.control = "needs_attention";
  h.store.save(run);
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: JSON.stringify(plan) });
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().control, "paused");
  assert.equal(h.run().planApproved, false);
  assert.equal(h.agents.created.length, 1);
});
describe("retry replaces invalid plans from structured output and MCP without bypassing approval", () => {
  for (const transport of ["structured", "mcp"])
    test(transport, async (t) => {
      const h = await harness({ requirePlanApproval: true });
      t.onTestFinished(() => h.cleanup());
      const original = await h.until("plan");
      const invalid = { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["missing"] }] };
      if (transport === "mcp") await h.engine.submit(h.id, "director", original.id, invalid);
      await h.complete(transport === "mcp" ? {} : invalid);
      assert.equal(h.run().control, "needs_attention");
      assert.match(h.run().message, /不存在的前置任务/);
      await h.restart();
      await h.engine.control(h.id, "retry");
      const replacement = await h.until("plan");
      assert.notEqual(replacement.id, original.id);
      assert.equal(replacement.agentId, original.agentId);
      assert.match(replacement.prompt, /不存在的前置任务：missing/);
      assert.equal(h.run().operations[0].state, "abandoned");
      assert.equal(h.run().plan, undefined);
      await h.complete(plan);
      assert.deepEqual(h.run().plan, plan);
      assert.equal(h.run().control, "paused");
      await assert.rejects(h.engine.control(h.id, "resume"), /批准总纲/);
      await h.engine.control(h.id, "approve_plan");
      await h.until("execute");
      assert.equal(
        h.run().operations.filter((candidateOperation) => candidateOperation.kind === "plan")
          .length,
        2,
      );
    });
});
test("explicit retries continue past the saved call limit", async (t) => {
  const h = await harness({ maxAttempts: 3 });
  t.onTestFinished(() => h.cleanup());
  const invalid = { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["task-1"] }] };
  for (let attempt = 0; attempt < 3; attempt++) {
    await h.until("plan");
    await h.complete(invalid);
    assert.equal(h.run().control, "needs_attention");
    if (attempt < 2) await h.engine.control(h.id, "retry");
  }
  await h.engine.control(h.id, "retry");
  await h.until("plan");
  assert.equal(h.run().operations.length, 4);
  assert.equal(h.run().control, "running");
  await h.complete(plan);
  assert.deepEqual(h.run().plan, plan);
});
test("interrupted output cannot be recovered on retry", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan"),
    run = h.run();
  run.control = "needs_attention";
  h.store.save(run);
  h.agents.states.set(op.agentId!, {
    status: "idle",
    seen: true,
    interrupted: true,
    output: JSON.stringify(plan),
  });
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().plan, undefined);
  assert.notEqual(h.op()!.id, op.id);
});
test("workspace launches preserve ownership and prevent overlapping runs on the same checkout", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  h.agents.directory = h.directory;
  const input = {
    requestId: "workspace-request",
    repository: h.directory,
    goal: "工作区内协作",
    workspaceId: "workspace-1",
    settings: settings(),
  };
  const [first, duplicate] = await Promise.all([h.engine.create(input), h.engine.create(input)]);
  assert.equal(first, duplicate);
  assert.equal(h.store.get(first).cwd, h.directory);
  assert.equal(h.store.get(first).workspaceId, "workspace-1");
  await assert.rejects(
    h.engine.create({
      ...input,
      requestId: "different",
      workspaceId: "same-directory-workspace-2",
    }),
    /未结束/,
  );
  await h.engine.control(first, "pause");
  await assert.rejects(h.engine.create({ ...input, requestId: "while-paused" }), /未结束/);
  await h.engine.control(first, "cancel");
  await h.engine.tick();
  const next = await h.engine.create({ ...input, requestId: "after-cancel" });
  assert.notEqual(next, first);
  await assert.rejects(
    h.engine.create({ ...input, requestId: "mismatch", repository: "/tmp" }),
    /不一致/,
  );
});
test("worktree isolation uses the created workspace and does not switch the source checkout", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  h.agents.directory = h.directory;
  const calls: string[] = [];
  h.agents.retainWorkspaceName = async () => {
    calls.push("retain-name");
  };
  h.repository.prepare = async (repository, runId, currentWorkspace = false) => {
    calls.push(currentWorkspace ? "local" : "worktree");
    return {
      repository,
      cwd: currentWorkspace ? repository : `/worktrees/${runId}`,
      baseCommit: "base",
      branch: `director/${runId}`,
      ...(currentWorkspace ? {} : { workspaceId: "wt-1" }),
    };
  };
  const input = {
    requestId: "isolate",
    repository: h.directory,
    goal: "独立执行",
    workspaceId: "source",
    isolation: "worktree" as const,
    settings: settings(),
  };
  const id = await h.engine.create(input);
  assert.deepEqual(calls, ["worktree"]);
  assert.equal(h.store.get(id).workspaceId, "wt-1");
  assert.equal(h.store.get(id).cwd, `/worktrees/${id}`);
  const stayed = await h.engine.create({ ...input, requestId: "stay", isolation: "local" });
  assert.equal(h.store.get(stayed).workspaceId, "source");
  assert.equal(h.store.get(stayed).cwd, h.directory);
  assert.deepEqual(calls, ["worktree", "retain-name", "local"]);
  // Only the source checkout carries the user's uncommitted work into the diff.
  const userChanges = /pre-existing user changes/;
  assert.doesNotMatch(buildPrompt(h.store.get(id), "plan", "op"), userChanges);
  assert.match(buildPrompt(h.store.get(stayed), "plan", "op"), userChanges);
});
test("workspace title is retained before switching branches, and a naming failure stops preparation", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  h.agents.directory = h.directory;
  const calls: string[] = [];
  h.agents.retainWorkspaceName = async () => {
    calls.push("retain-name");
  };
  const prepare = h.repository.prepare.bind(h.repository);
  h.repository.prepare = async (...args: Parameters<typeof prepare>) => {
    calls.push("switch-branch");
    return prepare(...args);
  };
  const input = {
    requestId: "name-test",
    repository: h.directory,
    goal: "测试名称",
    workspaceId: "original",
    settings: settings(),
  };
  await h.engine.create(input);
  assert.deepEqual(calls, ["retain-name", "switch-branch"]);
  await h.engine.create(input);
  assert.equal(calls.length, 2);
  h.agents.retainWorkspaceName = async () => {
    throw new Error("无法保留名称");
  };
  await h.engine.control(h.store.findRequest(input.requestId)!.id, "cancel");
  await h.engine.tick();
  await assert.rejects(h.engine.create({ ...input, requestId: "naming-failure" }), /无法保留名称/);
  assert.equal(calls.length, 2);
});
test("full workflow uses selected AI, returns to original director and requires final integration review", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const director = await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  await h.complete(result);
  assert.notEqual(h.run().phase, "completed");
  const final = await h.until("final");
  assert.equal(final.agentId, director.agentId);
  await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance");
  assert.equal(h.repository.verifications, 1);
  assert.notEqual(worker.agentId, director.agentId);
  assert.deepEqual(
    h.agents.created.map((a) => a.profile.provider),
    ["vendor-a/model-a", "vendor-b/model-b"],
  );
});
test("same provider can fill both roles using separate sessions", async (t) => {
  const h = await harness({ workerProfileId: "lead" });
  t.onTestFinished(() => h.cleanup());
  const main = await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  assert.notEqual(main.agentId, worker.agentId);
  assert.equal(h.agents.created[1].profile.id, "lead");
});
test("without extra commands the original director reviews, requests rework and gives final approval", async (t) => {
  const h = await harness({ verificationCommands: [] });
  t.onTestFinished(() => h.cleanup());
  const director = await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  await h.complete(result);
  assert.equal(h.run().phase, "executing");
  const firstReview = await h.until("final");
  assert.equal(firstReview.agentId, director.agentId);
  assert.match(
    firstReview.prompt,
    /The user specified no additional check commands; choose the verification method yourself/,
  );
  assert.equal(h.run().finalEvidence?.passed, false);
  assert.equal(h.run().finalEvidence?.verificationStatus, "not_configured");
  await h.complete(review(true, "changes_requested"));
  assert.equal((await h.until("execute")).agentId, worker.agentId);
  await h.complete(result);
  assert.notEqual(h.run().phase, "completed");
  const final = await h.until("final");
  assert.equal(final.agentId, director.agentId);
  await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance");
  assert.deepEqual(h.run().finalEvidence?.checks, []);
});
test("AI-only review still requires evidence for every original criterion", async (t) => {
  const h = await harness({ verificationCommands: [] });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete(result);
  await h.until("final");
  await h.complete({
    ...review(true),
    criteria: [{ criterion: "其他标准", passed: true, evidence: "查看了代码" }],
  });
  assert.equal(h.run().control, "needs_attention");
  assert.match(h.run().message, /审核未覆盖/);
});
test("duplicate events, restart, and duplicate create request never duplicate a sent task", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  const count = h.agents.sent.length;
  await Promise.all(Array.from({ length: 10 }, () => h.engine.tick()));
  await h.restart();
  await h.engine.tick();
  assert.equal(h.agents.sent.length, count);
  assert.equal(h.op()?.id, worker.id);
  assert.equal(
    await h.engine.create({
      requestId: "request-1",
      repository: "/repo",
      goal: "same",
      settings: settings(),
    }),
    h.id,
  );
  await h.complete(result);
  await h.until("final");
  assert.equal(h.agents.created.length, 2);
});
test("rework keeps the worker and continues past saved count limits until the time budget runs out", async (t) => {
  const h = await harness({ maxReworks: 1, maxAttempts: 3, runTimeoutMs: 60000 });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  for (let count = 1; count <= 12; count++) {
    await h.complete(result);
    await h.until("final");
    await h.complete(review(true, "changes_requested"));
    const redo = await h.until("execute");
    assert.equal(redo.agentId, worker.agentId);
    assert.match(redo.prompt, /增加空值处理/);
    assert.equal(h.run().tasks[0].reworks, count);
    assert.equal(h.run().finalEvidence, undefined);
    assert.equal(h.repository.discarded.length, count);
    assert.equal(awaitingAcceptance(h.run()), false);
    h.elapse(1000);
  }
  h.elapse(60000);
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  assert.match(h.run().message, /时间预算/);
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.deepEqual(h.agents.stopped, [worker.agentId]);
  assert.equal(h.run().tasks[0].reworks, 12);
});
test("retry recovers a submitted final review left behind by the old rework-limit stop", async (t) => {
  const h = await harness({ maxReworks: 0 });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete(result);
  const op = await h.until("final");
  // Older hosts recorded the review, then threw before finishing the operation.
  const stuck = h.run();
  const current = stuck.operations.find((candidate) => candidate.id === op.id)!;
  current.response = review(true, "changes_requested");
  current.responseHash = "old-host";
  stuck.control = "needs_attention";
  stuck.budgetUsedMs = stuck.settings.runTimeoutMs;
  stuck.runningSince = undefined;
  h.store.save(stuck);
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: "" });
  const sent = h.agents.sent.length;
  // The review arrived before the budget ran out; recovering it needs no more running time.
  h.elapse(1000);
  await h.engine.control(h.id, "retry");
  assert.equal(h.run().phase, "executing");
  assert.equal(h.run().control, "running");
  assert.equal(h.run().tasks[0].reworks, 1);
  assert.equal(awaitingAcceptance(h.run()), false);
  assert.equal(h.agents.sent.length, sent);
});
test("the time budget counts running time only and starts over when the user continues", async (t) => {
  // A short budget keeps the pause below the separate per-turn timeout.
  const h = await harness({ runTimeoutMs: 60000, turnTimeoutMs: 7200000 });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const op = await h.until("execute");
  const budget = h.run().settings.runTimeoutMs;
  h.elapse(budget - 1000);
  await h.engine.control(h.id, "pause");
  // Paused, blocked or waiting time is free.
  h.elapse(budget * 3);
  // Resuming sets the run going with the whole budget, not the second left before the pause.
  await h.engine.control(h.id, "resume");
  h.elapse(budget - 1000);
  await h.engine.tick();
  assert.equal(h.run().control, "running");
  // Running time counts, including a long turn that saves nothing in between.
  h.elapse(1000);
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  assert.match(h.run().message, /时间预算/);
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.deepEqual(h.agents.stopped, [op.agentId]);
  // Continuing after the budget ran out dispatches again on a fresh budget instead of stopping.
  await h.engine.control(h.id, "retry");
  const retried = await h.until("execute");
  assert.notEqual(retried.id, op.id);
  h.elapse(budget - 1000);
  await h.engine.tick();
  assert.equal(h.run().control, "running");
});
test("failed automatic verification cannot be overridden by director approval", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete(result);
  h.repository.passed = false;
  await h.until("final");
  await h.complete(review(true));
  assert.equal(h.run().control, "needs_attention");
  assert.notEqual(h.run().phase, "completed");
});
test("stale artifact and incomplete criteria are rejected", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete(result);
  await h.until("final");
  h.repository.version = "artifact-v2";
  await h.complete(review(true));
  assert.equal(h.run().control, "needs_attention");
  assert.match(h.run().message, /版本/);
});
test("pause gates new work, optional plan approval cannot be bypassed", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  assert.equal(h.run().control, "paused");
  await h.engine.tick();
  assert.equal(h.agents.created.length, 1);
  await assert.rejects(h.engine.control(h.id, "resume"), /批准总纲/);
  await h.engine.control(h.id, "approve_plan");
  await h.until("execute");
  await h.engine.control(h.id, "pause");
  await h.complete(result);
  assert.equal(h.run().phase, "executing");
  await h.engine.control(h.id, "resume");
  await h.engine.tick();
  assert.equal(h.run().phase, "executing");
});
test("planning paused before a plan exists can resume, then still waits for plan approval", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  await h.engine.control(h.id, "pause");
  assert.equal(canResumeRun(h.run()), true);
  await h.engine.control(h.id, "resume");
  const original = await h.until("plan");
  await h.engine.control(h.id, "pause");
  await h.complete(plan);
  await h.restart();
  assert.equal(h.run().plan, undefined);
  assert.equal(canResumeRun(h.run()), true);
  await h.engine.control(h.id, "resume");
  await h.engine.tick();
  assert.deepEqual(h.run().plan, plan);
  assert.equal(h.run().control, "paused");
  assert.equal(canResumeRun(h.run()), false);
  await assert.rejects(h.engine.control(h.id, "resume"), /批准总纲/);
  assert.deepEqual(
    h.agents.sent.map((candidateOperation) => candidateOperation.opId),
    [original.id],
  );
  await h.engine.control(h.id, "approve_plan");
  await h.until("execute");
});
test("permission wait is not success or an automatic retry", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.agents.states.set(op.agentId!, { status: "permission", seen: true, output: "" });
  await h.engine.tick();
  assert.equal(h.run().control, "waiting_permission");
  assert.equal(h.agents.created.length, 1);
  await h.complete(plan);
  assert.equal(h.run().control, "running");
  assert.equal(h.run().phase, "executing");
});
test("review queue reports a busy director and permissions before delivery, then resumes once", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const director = await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete(result);
  await h.engine.tick();
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.op()?.state, "ready");
  assert.match(h.run().message, /准备.*审核/);
  const sent = h.agents.sent.length;
  h.agents.states.set(director.agentId!, { status: "running", seen: false, output: "" });
  await h.engine.tick();
  assert.match(h.run().message, /总 AI.*上一轮.*审核指令尚未发送/);
  const events = h.run().events.length;
  await h.engine.tick();
  assert.equal(h.run().events.length, events);
  h.agents.states.set(director.agentId!, { status: "permission", seen: false, output: "" });
  await h.engine.tick();
  assert.equal(h.run().control, "waiting_permission");
  assert.match(h.run().message, /总 AI.*权限.*审核指令尚未发送/);
  assert.equal(h.agents.sent.length, sent);
  h.agents.states.set(director.agentId!, { status: "idle", seen: false, output: "" });
  await h.engine.tick();
  assert.equal(h.run().control, "running");
  assert.match(h.run().message, /已发送.*审核.*等待总 AI/);
  await h.engine.tick();
  assert.match(h.run().message, /总 AI 正在统一审核/);
  await h.engine.tick();
  assert.equal(h.agents.sent.length, sent + 1);
  await h.complete(review(true));
  assert.equal(h.run().tasks[0].status, "approved");
});
test("permission resolution records resumed work even when the operation was already busy", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const op = await h.until("execute");
  await h.engine.tick();
  h.agents.states.set(op.agentId!, { status: "permission", seen: true, output: "" });
  await h.engine.tick();
  h.agents.states.set(op.agentId!, { status: "running", seen: true, output: "" });
  await h.engine.tick();
  assert.equal(h.run().control, "running");
  assert.match(h.run().message, /权限.*已处理.*执行 AI/);
  const events = h.run().events.length;
  await h.engine.tick();
  assert.equal(h.run().events.length, events);
});
test("cancel stops the agent and rejects late MCP results", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  await h.engine.control(h.id, "cancel");
  await h.engine.tick();
  assert.equal(h.run().control, "canceled");
  assert.deepEqual(h.agents.stopped, [op.agentId]);
  await assert.rejects(h.engine.submit(h.id, "director", op.id, plan), /已经结束/);
});
test("cancel ends the run at once even when the AI cannot be stopped", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.agents.stop = async () => {
    throw new Error("会话已归档，请先恢复会话");
  };
  await h.engine.control(h.id, "cancel");
  assert.equal(h.run().control, "canceled");
  assert.match(h.run().message, /已取消.*未能停止.*会话已归档/);
  await assert.rejects(h.engine.control(h.id, "cancel"), /任务已结束/);
  await assert.rejects(h.engine.submit(h.id, "director", op.id, plan), /已经结束/);
  await h.engine.tick();
  assert.equal(h.run().control, "canceled");
});
test("a cancel saved by an older host while stopping finishes on the next tick", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  const run = h.run();
  run.control = "canceling";
  run.stopTarget = "canceled";
  h.store.save(run);
  await h.engine.tick();
  assert.equal(h.run().control, "canceled");
  assert.deepEqual(h.agents.stopped, [op.agentId]);
});
test("a timeout whose stop fails needs attention instead of stopping again every tick", async (t) => {
  const h = await harness({ turnTimeoutMs: 1000 });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  let attempts = 0;
  h.agents.stop = async () => {
    attempts++;
    throw new Error("AI 会话拒绝停止当前轮次");
  };
  h.elapse(1001);
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.match(h.run().message, /拒绝停止/);
  await h.engine.tick();
  assert.equal(attempts, 1);
  await h.engine.control(h.id, "cancel");
  assert.equal(h.run().control, "canceled");
});
test("a stop that fails with a network error needs attention instead of promising a retry", async (t) => {
  const h = await harness({ turnTimeoutMs: 1000 });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  let attempts = 0;
  h.agents.stop = async () => {
    attempts++;
    throw new Error("Codex app-server connection closed");
  };
  h.elapse(1001);
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.equal(h.run().message, "Codex app-server connection closed");
  assert.equal(h.run().autoRetry, undefined);
  h.elapse(31_000);
  await h.engine.tick();
  assert.equal(attempts, 1);
  assert.equal(h.agents.sent.length, 1);
});
test("crash after sending recovers from timeline marker, ambiguous delivery stops", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  let run = h.run();
  run.operations[0].state = "sending";
  h.store.save(run);
  await h.restart();
  await h.engine.tick();
  assert.equal(h.op()?.state, "sent");
  assert.equal(h.agents.sent.length, 1);
  run = h.run();
  run.operations[0].state = "sending";
  h.store.save(run);
  h.agents.states.set(op.agentId!, { status: "idle", seen: false, output: "" });
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.equal(h.agents.sent.length, 1);
});
test("MCP submissions validate actor and operation and cannot finish a still running turn", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  await assert.rejects(h.engine.submit(h.id, "task-1", op.id, plan), /无权/);
  await assert.rejects(h.engine.submit(h.id, "director", "old-operation", plan), /已经结束/);
  await h.engine.submit(h.id, "director", op.id, plan);
  await h.engine.submit(h.id, "director", op.id, plan);
  await h.engine.tick();
  assert.equal(h.run().phase, "planning");
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: "" });
  await h.engine.tick();
  assert.equal(h.run().phase, "executing");
});
test("timeout first stops the AI before offering retry", async (t) => {
  const h = await harness({ turnTimeoutMs: 1000 });
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.elapse(1001);
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.deepEqual(h.agents.stopped, [op.agentId]);
});
test("the step limit stops a silent turn, not one that keeps working", async (t) => {
  const h = await harness({ turnTimeoutMs: 1000 });
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.elapse(800);
  h.agents.states.set(op.agentId!, {
    status: "running",
    seen: true,
    output: "",
    activeAt: h.now(),
  });
  h.elapse(800);
  await h.engine.tick();
  assert.equal(h.run().control, "running");
  h.elapse(200);
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  assert.match(h.run().message, /没有进展/);
});
test("a finished result is collected even when the next observation is after the step limit", async (t) => {
  const h = await harness({ turnTimeoutMs: 1000 });
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.elapse(1001);
  await h.complete(plan);
  assert.equal(h.run().control, "running");
  assert.equal(h.run().phase, "executing");
  assert.equal(h.run().operations.find((candidate) => candidate.id === op.id)?.state, "done");
  assert.deepEqual(h.agents.stopped, []);
});
describe("main-chat step limits", () => {
  for (const kind of ["plan", "final"] as const) {
    test(`an idle ${kind} without a submission stops after the step limit`, async (t) => {
      const h = await harness({ turnTimeoutMs: 1000 });
      t.onTestFinished(() => h.cleanup());
      if (kind === "final") {
        await h.until("plan");
        await h.complete(plan);
        await h.until("execute");
        await h.complete(result);
      }
      const op = await h.until(kind);
      const run = h.run();
      run.chat = { version: 1, conversationId: "conversation", mainAgentId: op.agentId! };
      h.store.save(run);
      h.agents.states.set(op.agentId!, {
        status: "idle",
        seen: true,
        output: "我会继续处理",
        activeAt: h.now(),
      });
      h.elapse(999);
      await h.engine.tick();
      assert.equal(h.run().control, "running");
      h.elapse(1);
      await h.engine.tick();
      assert.equal(h.run().control, "canceling");
      await h.engine.tick();
      assert.equal(h.run().control, "needs_attention");
      assert.match(h.run().message, /没有进展/);
      assert.equal(h.op()?.id, op.id);
      assert.deepEqual(h.agents.stopped, []);
    });
    test(`a submitted ${kind} is collected after the step limit`, async (t) => {
      const h = await harness({ turnTimeoutMs: 1000 });
      t.onTestFinished(() => h.cleanup());
      if (kind === "final") {
        await h.until("plan");
        await h.complete(plan);
        await h.until("execute");
        await h.complete(result);
      }
      const op = await h.until(kind);
      const run = h.run();
      run.chat = { version: 1, conversationId: "conversation", mainAgentId: op.agentId! };
      h.store.save(run);
      await h.engine.submit(h.id, "director", op.id, kind === "plan" ? plan : review(true));
      h.elapse(1001);
      await h.engine.tick();
      assert.equal(h.run().phase, kind === "plan" ? "executing" : "awaiting_acceptance");
      assert.equal(h.run().operations.find((candidate) => candidate.id === op.id)?.state, "done");
      assert.deepEqual(h.agents.stopped, []);
    });
  }
});
test("repeated shell polling stops the worker before retry and retains its workspace and reason", async (t) => {
  const h = await harness(reviewerSettings(), "execute_review");
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("execute");
  const cwd = h.run().cwd;
  h.agents.states.set(op.agentId!, {
    status: "running",
    seen: true,
    output: "",
    activeAt: h.now(),
    hasRepeatedShellCalls: hasRepeatedShellCalls(shellPollingRows(), "operation"),
  });
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  assert.match(h.run().message, /重复空转/);
  h.agents.holdInFlight.add(op.agentId!);
  await h.engine.tick();
  assert.equal(h.run().control, "canceling");
  assert.equal(h.agents.created.length, 1);
  assert.equal(h.agents.sent.length, 1);
  const stoppingMessage = h.run().message;
  await assert.rejects(
    h.engine.control(h.id, "note", undefined, { feedback: "保留测试日志" }),
    /正在停止 AI/,
  );
  assert.equal(h.run().message, stoppingMessage);
  assert.deepEqual(h.run().notes ?? [], []);
  h.agents.holdInFlight.delete(op.agentId!);
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
  assert.match(h.run().message, /重复空转/);
  assert.equal(h.run().cwd, cwd);
  await h.engine.control(h.id, "retry");
  const retried = await h.until("execute");
  assert.equal(retried.agentId, op.agentId);
  assert.match(retried.prompt, /first check whether the process is still running/);
  await h.complete(result);
  await h.until("final");
  await h.complete({
    ...review(true),
    criteria: finalAcceptance(h.run().plan!).map((criterion) => ({
      criterion,
      passed: true,
      evidence: "实际代码和测试",
    })),
  });
  assert.equal(h.run().phase, "awaiting_acceptance");
});
test("permission waits and finished worker results win over a repeated-tool signal", async (t) => {
  const h = await harness(reviewerSettings(), "execute_review");
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("execute");
  h.agents.states.set(op.agentId!, {
    status: "permission",
    seen: true,
    output: "",
    hasRepeatedShellCalls: true,
  });
  await h.engine.tick();
  assert.equal(h.run().control, "waiting_permission");
  h.agents.states.set(op.agentId!, {
    status: "idle",
    seen: true,
    output: JSON.stringify(result),
    hasRepeatedShellCalls: true,
  });
  await h.engine.tick();
  assert.equal(h.run().tasks[0].status, "executed");
  assert.equal(h.run().control, "running");
  assert.deepEqual(h.agents.stopped, []);
});
test("manual steering invalidates automatic consumption of the old turn", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  h.agents.states.set(op.agentId!, {
    status: "idle",
    seen: true,
    output: JSON.stringify(plan),
    interrupted: true,
  });
  await h.engine.tick();
  assert.equal(h.run().control, "needs_attention");
});
test("routing uses user task override, category override, then allowed selection", () => {
  const s = settings(),
    task = { ...plan.tasks[0], executorId: "lead" };
  assert.equal(profileForTask(s, task), "worker");
  s.allowDirectorSelection = true;
  assert.equal(profileForTask(s, task), "lead");
  s.categoryOverrides.backend = "worker";
  assert.equal(profileForTask(s, task), "worker");
  s.taskOverrides[task.id] = "lead";
  assert.equal(profileForTask(s, task), "lead");
});
test("invalid graphs and fabricated provider IDs cannot dispatch", () => {
  const s = settings();
  assert.throws(
    () => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["task-1"] }] }, s),
    /循环/,
  );
  assert.throws(
    () => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["missing"] }] }, s),
    /不存在/,
  );
  s.allowDirectorSelection = true;
  assert.throws(
    () => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], executorId: "unknown" }] }, s),
    /未知 AI/,
  );
  assert.deepEqual(parseOutput('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(
    parseOutput('正在核对代码。\n{"summary":"包含 } 和 \\" 字符","nested":{"ok":true}}'),
    { summary: '包含 } 和 " 字符', nested: { ok: true } },
  );
  assert.throws(() => parseOutput("all done"));
  assert.throws(
    () => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], id: "director" }] }, s),
    /保留/,
  );
});
test("paused in-flight MCP submission is saved without advancing", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  await h.engine.control(h.id, "pause");
  await h.engine.submit(h.id, "director", op.id, plan);
  await h.engine.tick();
  assert.equal(h.run().phase, "planning");
  h.agents.states.set(op.agentId!, { status: "idle", seen: true, output: "" });
  await h.engine.control(h.id, "resume");
  await h.engine.tick();
  assert.equal(h.run().phase, "executing");
});
test("new requirements stop the old turn and invalidate its late results", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const worker = await h.until("execute");
  await h.engine.control(h.id, "pause");
  await h.engine.control(h.id, "revise", "增加新功能和错误处理");
  assert.equal(h.run().phase, "planning");
  assert.equal(h.run().planVersion, 2);
  assert.equal(h.run().tasks.length, 0);
  assert.ok(h.agents.stopped.includes(worker.agentId!));
  await assert.rejects(h.engine.submit(h.id, "task-1", worker.id, result), /已经结束/);
  const updated = await h.until("plan");
  assert.match(updated.prompt, /增加新功能/);
});
test("cancel reconciles a child created just before a checkpoint crash", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  const run = h.run();
  const op = run.operations[0];
  op.state = "creating";
  op.agentId = undefined;
  h.store.save(run);
  await h.engine.control(h.id, "cancel");
  await h.engine.tick();
  assert.equal(h.run().control, "canceled");
  assert.deepEqual(h.agents.stopped, [h.agents.created[0].id]);
});
test("unified review rework invalidates executed dependent tasks", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  const second = { ...plan.tasks[0], id: "task-2", title: "依赖任务", dependsOn: ["task-1"] };
  await h.complete({ ...plan, tasks: [...plan.tasks, second] });
  for (let i = 0; i < 2; i++) {
    await h.until("execute");
    await h.complete(result);
  }
  await h.until("final");
  await h.complete(review(true, "changes_requested"));
  assert.deepEqual(
    h.run().tasks.map((candidateTask) => candidateTask.status),
    ["pending", "pending"],
  );
  assert.equal(h.run().tasks[0].reworks, 1);
  assert.equal(h.run().tasks[1].review, undefined);
});

test("role agents on another provider than the conversation use that provider's default mode", () => {
  const modes = [
    { id: "default", label: "Ask" },
    { id: "plan", label: "Plan" },
  ];
  const base = { parentProvider: "claude", targetProvider: "antigravity-hub", modes };
  // A Claude conversation in `auto` cannot pass its mode to a Hub worker.
  assert.equal(
    profileCreateMode({ ...base, profileMode: undefined, defaultModeId: null }),
    "default",
  );
  assert.equal(
    profileCreateMode({ ...base, profileMode: undefined, defaultModeId: "plan" }),
    "plan",
  );
  assert.equal(
    profileCreateMode({ ...base, profileMode: undefined, defaultModeId: "missing" }),
    "default",
  );
  assert.equal(profileCreateMode({ ...base, profileMode: "plan", defaultModeId: null }), "plan");
  // Same provider keeps inheriting the conversation's mode.
  assert.equal(
    profileCreateMode({
      ...base,
      targetProvider: "claude",
      profileMode: undefined,
      defaultModeId: null,
    }),
    undefined,
  );
  assert.equal(
    profileCreateMode({
      ...base,
      parentProvider: undefined,
      profileMode: undefined,
      defaultModeId: null,
    }),
    undefined,
  );
  assert.equal(
    profileCreateMode({ ...base, modes: [], profileMode: undefined, defaultModeId: null }),
    undefined,
  );
});

test("unattended role sessions use full access despite saved defaults or the conversation provider", () => {
  const modes = [
    { id: "auto", label: "Default" },
    { id: "full-access", label: "Full Access", isUnattended: true },
  ];
  for (const parentProvider of [undefined, "codex", "claude"]) {
    for (const profileMode of [undefined, "auto"]) {
      assert.equal(
        profileCreateMode({
          profileMode,
          parentProvider,
          targetProvider: "codex",
          defaultModeId: "auto",
          modes,
          unattended: true,
        }),
        "full-access",
      );
    }
  }
});

test("stopping skips sessions that are not loaded and reports a refused interrupt", async () => {
  const canceled: string[] = [];
  const host = {
    agentManager: {
      getAgent: (agentId: string) => (agentId === "archived" ? undefined : { id: agentId }),
      cancelAgentRun: async (agentId: string) => {
        canceled.push(agentId);
        return { status: agentId === "stuck" ? "refused" : "settled" };
      },
    },
    agentStorage: {
      get: async () => {
        throw new Error("stop must not read the archived record");
      },
    },
  } as unknown as CollaborationHost;
  const gateway = new CollaborationGateway(host);
  await gateway.stop("archived");
  await gateway.stop("live");
  await assert.rejects(gateway.stop("stuck"), /拒绝停止/);
  assert.deepEqual(canceled, ["live", "stuck"]);
});
test("inspecting a session reports when it last showed activity", async () => {
  const updatedAt = new Date("2026-10-14T15:42:00Z");
  const host = {
    agentStorage: { get: async () => ({ id: "worker", labels: {} }) },
    agentManager: {
      getAgent: () => ({ lifecycle: "running", pendingPermissions: new Map(), updatedAt }),
      hasInFlightRun: () => true,
      getTimelineRows: async () => shellPollingRows(),
    },
  } as unknown as CollaborationHost;
  const state = await new CollaborationGateway(host).inspect("worker", "operation");
  assert.equal(state.status, "running");
  assert.equal(state.activeAt, updatedAt.getTime());
  assert.equal(state.hasRepeatedShellCalls, true);
});

describe("worker session continuity", () => {
  const twoTasks = {
    ...plan,
    tasks: [
      plan.tasks[0],
      { ...plan.tasks[0], id: "task-2", title: "复测", description: "复测并记录" },
    ],
  };
  test("serial tasks on one profile continue in the same session with earlier results handed over", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await h.complete(twoTasks);
    const first = await h.until("execute");
    await h.complete({ ...result, summary: "基线脚本位于 scripts/measure.mjs" });
    const second = await h.until("execute");
    assert.equal(second.taskId, "task-2");
    assert.equal(second.agentId, first.agentId);
    assert.equal(h.agents.created.length, 2);
    assert.match(second.prompt, /基线脚本位于 scripts\/measure\.mjs/);
    assert.match(second.prompt, /same execution session/);
  });
  test("revised requirements keep the worker session", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await h.complete(plan);
    const worker = await h.until("execute");
    await h.engine.control(h.id, "pause");
    await h.engine.control(h.id, "revise", "实现新功能，并补充错误处理");
    await h.until("plan");
    await h.complete(plan);
    const resumed = await h.until("execute");
    assert.equal(resumed.agentId, worker.agentId);
    assert.equal(h.agents.created.length, 2);
  });
  test("a reused session that is gone is replaced instead of stopping the run", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await h.complete(twoTasks);
    const first = await h.until("execute");
    await h.complete(result);
    h.agents.states.set(first.agentId!, { status: "missing", seen: false, output: "" });
    const second = await h.until("execute");
    assert.notEqual(second.agentId, first.agentId);
    assert.equal(h.run().control, "running");
    assert.doesNotMatch(second.prompt, /same execution session/);
  });
  test("a turn that ends without a result is asked to report in the same session", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await h.complete(plan);
    const worker = await h.until("execute");
    for (let attempt = 0; attempt < 2; attempt++) {
      h.agents.states.set(worker.agentId!, { status: "idle", seen: true, output: "" });
      h.elapse(21000);
      await h.engine.tick();
      assert.equal(h.run().control, "running");
      const nudge = await h.until("execute");
      assert.equal(nudge.agentId, worker.agentId);
      assert.match(nudge.prompt, /without submitting a task result/);
    }
    h.agents.states.set(worker.agentId!, { status: "idle", seen: true, output: "" });
    h.elapse(21000);
    await h.engine.tick();
    assert.equal(h.run().control, "needs_attention");
  });
});

describe("automatic retry of transient provider errors", () => {
  async function failingExecution(error: string) {
    const h = await harness();
    await h.until("plan");
    await h.complete(plan);
    const worker = await h.until("execute");
    h.agents.states.set(worker.agentId!, { status: "error", seen: true, output: "", error });
    return { h, worker };
  }
  test("a connection failure retries by itself after a delay", async (t) => {
    const { h, worker } = await failingExecution(
      'request failed: Post "https://example.invalid/v1:streamGenerateContent": EOF',
    );
    t.onTestFinished(() => h.cleanup());
    await h.engine.tick();
    assert.equal(h.run().control, "running");
    assert.match(h.run().message, /自动重试/);
    const sends = h.agents.sent.length;
    await h.engine.tick();
    assert.equal(h.agents.sent.length, sends);
    h.elapse(31000);
    await h.engine.tick();
    const retried = await h.until("execute");
    assert.notEqual(retried.id, worker.id);
    assert.equal(h.agents.sent.length, sends + 1);
    assert.match(retried.prompt, /This round is a retry/);
    await h.complete(result);
    assert.equal(h.run().autoRetry, undefined);
  });
  test("automatic retries stop after three attempts", async (t) => {
    const { h } = await failingExecution("503 Service Unavailable: model overloaded");
    t.onTestFinished(() => h.cleanup());
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.engine.tick();
      assert.equal(h.run().control, "running");
      h.elapse(301000);
      await h.engine.tick();
      const retried = await h.until("execute");
      h.agents.states.set(retried.agentId!, {
        status: "error",
        seen: true,
        output: "",
        error: "503 Service Unavailable: model overloaded",
      });
    }
    await h.engine.tick();
    assert.equal(h.run().control, "needs_attention");
  });
  test("quota and usage limits still wait for the user", async (t) => {
    const { h } = await failingExecution(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 162h20m34s.",
    );
    t.onTestFinished(() => h.cleanup());
    await h.engine.tick();
    assert.equal(h.run().control, "needs_attention");
    assert.equal(h.run().autoRetry, undefined);
  });
  test("pausing during the wait keeps the retry for later", async (t) => {
    const { h, worker } = await failingExecution("socket hang up");
    t.onTestFinished(() => h.cleanup());
    await h.engine.tick();
    await h.engine.control(h.id, "pause");
    h.elapse(31000);
    await h.engine.tick();
    assert.equal(h.run().activeOperationId, worker.id);
    await h.engine.control(h.id, "resume");
    await h.engine.tick();
    const retried = await h.until("execute");
    assert.notEqual(retried.id, worker.id);
  });
});

describe("quick corrections", () => {
  test("a note reaches the next worker and the reviewer without re-planning", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await h.complete({
      ...plan,
      tasks: [plan.tasks[0], { ...plan.tasks[0], id: "task-2", title: "复测" }],
    });
    const first = await h.until("execute");
    await h.engine.control(h.id, "note", undefined, { feedback: "测量数据不要提交到仓库" });
    assert.equal(h.run().phase, "executing");
    assert.equal(h.run().control, "running");
    assert.equal(h.run().planVersion ?? 1, 1);
    assert.equal(h.run().activeOperationId, first.id);
    assert.match(h.run().message, /补充要求/);
    await h.complete(result);
    const second = await h.until("execute");
    assert.match(second.prompt, /测量数据不要提交到仓库/);
    await h.complete(result);
    const final = await h.until("final");
    assert.match(final.prompt, /测量数据不要提交到仓库/);
    assert.equal(h.run().operations.filter((o) => o.kind === "plan").length, 1);
  });
  test("a note added after a step was queued is attached when it is sent", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await h.complete(plan);
    await h.engine.tick();
    assert.equal(h.op()?.state, "pending");
    await h.engine.control(h.id, "note", undefined, { feedback: "保留原有画质设置" });
    const worker = await h.until("execute");
    assert.match(worker.prompt, /保留原有画质设置/);
    assert.equal(worker.prompt.match(/保留原有画质设置/g)?.length, 1);
  });
  test("a note needs text and is refused at acceptance", async (t) => {
    const h = await harness();
    t.onTestFinished(() => h.cleanup());
    await h.until("plan");
    await assert.rejects(h.engine.control(h.id, "note"), /补充要求不能为空/);
    await h.complete(plan);
    await h.until("execute");
    await h.complete(result);
    await h.until("final");
    await h.complete(review(true));
    await assert.rejects(
      h.engine.control(h.id, "note", undefined, { feedback: "再改一下" }),
      /请验收成果或提交修改意见/,
    );
  });
});
