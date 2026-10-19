import { test } from "vitest";
import assert from "node:assert/strict";
import { harness, plan, result, review } from "./test-utils/harness.js";
import { workflowEvidence } from "./workflow-evidence.js";
import { readFileSync } from "node:fs";
import { buildPrompt } from "./prompts.js";

test("approval, delivery and accepted review times survive restart and event truncation", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  assert.equal(workflowEvidence(h.run()).planApproval.userApprovedAt, null);
  h.elapse(1000);
  await h.engine.control(h.id, "approve_plan");
  h.elapse(1000);
  const worker = await h.until("execute");
  h.elapse(1000);
  await h.complete(result);
  await h.until("final");
  h.elapse(1000);
  await h.complete(review(true));
  const r = h.run();
  r.events = [];
  h.store.save(r);
  await h.restart();
  const evidence = workflowEvidence(h.run());
  assert.equal(evidence.planApproval.timestampSource, "checkpoint");
  const execution = evidence.operations.find(
    (candidateOperation) => candidateOperation.operationId === worker.id,
  )!;
  assert.ok(evidence.planApproval.userApprovedAt! < execution.sendRequestedAt!);
  assert.ok(execution.deliveryConfirmedAt! >= execution.sendRequestedAt!);
  assert.ok(execution.resultAcceptedAt! > execution.deliveryConfirmedAt!);
  const approved = evidence.operations.find(
    (candidateOperation) => candidateOperation.kind === "final",
  )!;
  assert.equal(approved.reviewDecision, "approved");
  assert.equal(approved.artifactId, "artifact-v1");
  assert.ok(approved.resultAcceptedAt! > execution.resultAcceptedAt!);
});

test("legacy approval uses actual events and absent historical times stay unknown", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  h.elapse(1000);
  await h.engine.control(h.id, "approve_plan");
  h.elapse(1000);
  await h.until("execute");
  const r = h.run(),
    approval = r.events.find((e) => e.message === "总纲已批准")!;
  r.planApprovedAt = undefined;
  for (const op of r.operations) {
    op.completedAt = undefined;
    op.deliveryConfirmedAt = undefined;
  }
  const evidence = workflowEvidence(r);
  assert.equal(evidence.planApproval.userApprovedAt, new Date(approval.time).toISOString());
  assert.equal(evidence.planApproval.timestampSource, "legacy_event");
  assert.equal(
    evidence.operations.find((candidateOperation) => candidateOperation.kind === "execute")!
      .deliveryConfirmedAt,
    null,
  );
  r.events = [];
  assert.equal(workflowEvidence(r).planApproval.userApprovedAt, null);
  assert.equal(workflowEvidence(r).planApproval.timestampSource, "unavailable");
});

test("revised plans cannot reuse the old plan's manual approval evidence", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.engine.control(h.id, "approve_plan");
  await h.engine.control(h.id, "pause");
  h.elapse(1000);
  await h.engine.control(h.id, "revise", "修改目标");
  assert.equal(h.run().planApprovedAt, undefined);
  h.elapse(1000);
  await h.until("plan");
  await h.complete(plan);
  const evidence = workflowEvidence(h.run());
  assert.equal(evidence.planApproval.approved, false);
  assert.equal(evidence.planApproval.userApprovedAt, null);
  assert.equal(
    evidence.events.some((e) => e.message === "总纲已批准"),
    false,
  );
});

test("blocked final review receives workflow evidence on retry without rerunning workers", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  const director = await h.until("plan");
  await h.complete(plan);
  await h.engine.control(h.id, "approve_plan");
  await h.until("execute");
  await h.complete(result);
  await h.until("final");
  await h.complete({ ...review(true, "blocked"), summary: "缺少流程记录" });
  assert.equal(h.run().control, "needs_attention");
  const executions = h.agents.sent.filter((sent) =>
    sent.prompt.includes("You are the implementation AI."),
  );
  await h.engine.control(h.id, "retry");
  const final = await h.until("final");
  assert.equal(final.agentId, director.agentId);
  const context = JSON.parse(
    final.prompt.slice(
      final.prompt.indexOf("\n\n{") + 2,
      final.prompt.indexOf("\n\nCurrent operationId="),
    ),
  );
  assert.equal(context.previousReview.summary, "缺少流程记录");
  assert.equal(context.workflowEvidence.planApproval.approved, true);
  assert.ok(context.workflowEvidence.planApproval.userApprovedAt);
  assert.equal(
    JSON.parse(readFileSync(context.contextFiles.workflow, "utf8")).operations.some(
      (candidateOperation: { prompt?: string; response?: unknown }) =>
        candidateOperation.prompt || candidateOperation.response,
    ),
    false,
  );
  assert.deepEqual(
    h.agents.sent.filter((sent) => sent.prompt.includes("You are the implementation AI.")),
    executions,
  );
  assert.equal(h.agents.created.length, 2);
  assert.equal(h.run().tasks[0].status, "executed");
  await h.complete(review(true));
  assert.equal(h.run().phase, "awaiting_acceptance");
});

test("review dispatch references complete evidence and retains findings through rework", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  await h.until("execute");
  await h.complete(result);
  const first = await h.until("final");
  await h.complete(review(true, "changes_requested"));
  await h.until("execute");
  await h.complete(result);
  const second = await h.until("final");
  const promptContext = (prompt: string) =>
    JSON.parse(
      prompt.slice(prompt.indexOf("\n\n{") + 2, prompt.indexOf("\n\nCurrent operationId=")),
    );
  const context = promptContext(second.prompt);
  assert.equal(context.previousReview.findings[0].problem, "遗漏空值");
  assert.equal("diff" in context.evidence, false);
  assert.equal("output" in context.evidence.checks[0], false);
  assert.equal("operations" in context.workflowEvidence, false);
  const large = h.run();
  large.finalEvidence!.diff = "LARGE_PATCH".repeat(4800);
  large.finalEvidence!.checks[0].output = "LARGE_LOG".repeat(600);
  const bounded = buildPrompt(large, "final", "size-check", undefined, {
    files: context.contextFiles,
  });
  assert.equal(bounded.includes("LARGE_PATCH"), false);
  assert.equal(bounded.includes("LARGE_LOG"), false);
  assert.ok(bounded.length < 15000);

  assert.ok(readFileSync(context.contextFiles.workflow, "utf8").includes(first.id));
  assert.equal(
    JSON.parse(readFileSync(context.contextFiles.results, "utf8"))[0].result.summary,
    result.summary,
  );
  assert.equal(
    JSON.parse(readFileSync(context.contextFiles.previousReview, "utf8")).decision,
    "changes_requested",
  );
});

test("usage is attributed to the original operation after submission and survives restart without duplicate counting", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  await h.engine.recordUsage(op.agentId!, { type: "turn_started", turnId: "provider-turn" });
  await h.complete(plan);
  await h.engine.recordUsage(op.agentId!, {
    type: "turn_completed",
    turnId: "provider-turn",
    usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalCostUsd: 0.01 },
  });
  await h.engine.recordUsage(op.agentId!, {
    type: "turn_completed",
    turnId: "provider-turn",
    usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalCostUsd: 0.01 },
  });
  await h.restart();
  assert.deepEqual(h.run().operations.find((candidate) => candidate.id === op.id)!.usage, [
    {
      turnId: "provider-turn",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      totalCostUsd: 0.01,
    },
  ]);
});

test("execution dispatch excludes unrelated results and reads full dependency evidence on demand", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete({
    ...plan,
    tasks: [
      plan.tasks[0],
      { ...plan.tasks[0], id: "unrelated" },
      { ...plan.tasks[0], id: "dependent", dependsOn: ["task-1"] },
    ],
  });
  await h.until("execute");
  await h.complete(result);
  await h.until("execute");
  await h.complete({ ...result, summary: "UNRELATED_RESULT".repeat(1000) });
  const execution = await h.until("execute");
  const context = JSON.parse(
    execution.prompt.slice(
      execution.prompt.indexOf("\n\n{") + 2,
      execution.prompt.indexOf("\n\nCurrent operationId="),
    ),
  );
  assert.deepEqual(
    context.completedTasks.map((task: { id: string }) => task.id),
    ["task-1"],
  );
  assert.deepEqual(
    context.plan.tasks.map((task: { id: string }) => task.id),
    ["dependent"],
  );
  assert.equal(execution.prompt.includes("UNRELATED_RESULT"), false);
  assert.match(readFileSync(context.contextFiles.results, "utf8"), /UNRELATED_RESULT/);
});

test("usage terminal events queued with turn start are retained and absent metrics stay unknown", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  const op = await h.until("plan");
  await Promise.all([
    h.engine.recordUsage(op.agentId!, { type: "turn_started", turnId: "fast-turn" }),
    h.engine.recordUsage(op.agentId!, {
      type: "turn_completed",
      turnId: "fast-turn",
      usage: { inputTokens: 7 },
    }),
  ]);
  assert.deepEqual(h.run().operations.at(-1)!.usage, [{ turnId: "fast-turn", inputTokens: 7 }]);
  await h.engine.recordUsage(op.agentId!, { type: "turn_started", turnId: "unknown-turn" });
  await h.engine.recordUsage(op.agentId!, { type: "turn_completed", turnId: "unknown-turn" });
  assert.deepEqual(h.run().operations.at(-1)!.usage, [{ turnId: "fast-turn", inputTokens: 7 }]);
});
