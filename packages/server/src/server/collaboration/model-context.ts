import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ReviewSchema,
  type Run,
  type Operation,
  type Evidence,
} from "@getpaseo/protocol/collaboration/schema";
import { workflowEvidence } from "./workflow-evidence.js";

export const StatusOptionsSchema = z.object({
  detail: z.enum(["operation", "plan", "results", "review", "history", "usage"]).optional(),
  operationId: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type StatusOptions = z.infer<typeof StatusOptionsSchema>;

export function operationSummary(op: Operation) {
  return {
    id: op.id,
    kind: op.kind,
    taskId: op.taskId,
    profileId: op.profileId,
    agentId: op.agentId,
    state: op.state,
    createdAt: op.createdAt,
    completedAt: op.completedAt,
  };
}

export function latestReview(run: Run, taskId?: string) {
  const saved = taskId
    ? run.tasks.find((task) => task.spec.id === taskId)?.review
    : run.finalReview;
  if (saved) return saved;
  const previous = run.operations.findLast(
    (op) => op.state === "done" && op.taskId === taskId && ["review", "final"].includes(op.kind),
  );
  const parsed = ReviewSchema.safeParse(previous?.response);
  return parsed.success ? parsed.data : undefined;
}

export function evidenceReference(evidence?: Evidence) {
  if (!evidence) return;
  return {
    id: evidence.id,
    tree: evidence.tree,
    diffPath: evidence.diffPath,
    changedFiles: evidence.changedFiles,
    delta: evidence.delta,
    capturedAt: evidence.capturedAt,
    passed: evidence.passed,
    verificationStatus: evidence.verificationStatus,
    checks: evidence.checks.map(({ output: _output, ...check }) => check),
  };
}

export function runStatus(run: Run) {
  const review = latestReview(run);
  return {
    id: run.id,
    goal: run.goal.slice(0, 1000),
    phase: run.phase,
    control: run.control,
    message: run.message,
    cwd: run.cwd,
    branch: run.branch,
    sourceBranch: run.sourceBranch,
    planApproved: run.planApproved,
    planVersion: run.planVersion,
    delivery: run.delivery,
    userAcceptance: run.userAcceptance,
    finalReview: review && {
      decision: review.decision,
      summary: review.summary.slice(0, 1000),
      artifactId: review.artifactId,
      findingCount: review.findings.length,
      findings: review.findings.slice(0, 5).map((finding) => ({
        taskId: finding.taskId,
        location: finding.location.slice(0, 200),
        problem: finding.problem.slice(0, 300),
      })),
    },
    tasks: run.tasks.map((task) => ({
      id: task.spec.id,
      title: task.spec.title.slice(0, 200),
      status: task.status,
      reworks: task.reworks,
    })),
  };
}

export function statusDetails(run: Run, options: StatusOptions, agentId?: string) {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 5;
  const page = <T>(items: T[]) => ({
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  });
  switch (options.detail) {
    case "operation": {
      const op = run.operations.find((candidate) => candidate.id === run.activeOperationId);
      return op?.agentId === agentId ? op?.prompt : undefined;
    }
    case "plan":
      return run.plan;
    case "results":
      return page(run.tasks.map((task) => ({ id: task.spec.id, result: task.result })));
    case "review":
      return latestReview(run);
    case "history": {
      if (!options.operationId) return page(run.operations.map(operationSummary));
      const op = run.operations.find((candidate) => candidate.id === options.operationId);
      if (!op) throw new Error("协作操作不存在");
      return { ...operationSummary(op), response: op.response };
    }
    case "usage":
      return page(
        run.operations.map((op, index) => ({
          ...operationSummary(op),
          role: { execute: "execution", plan: "planning", review: "review", final: "review" }[
            op.kind
          ],
          round: run.operations
            .slice(0, index + 1)
            .filter((previous) => previous.kind === op.kind && previous.taskId === op.taskId)
            .length,
          model:
            op.executionModel?.provider ??
            run.settings.profiles.find((profile) => profile.id === op.profileId)?.provider,
          usage: op.usage,
        })),
      );
  }
}

/** Immutable, operation-scoped evidence files keep full reports available without replaying them. */
export function writeContextFiles(root: string, run: Run, operationId: string) {
  const directory = join(root, "artifacts", run.id, operationId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = {
    plan: run.plan,
    results: run.tasks.map((task) => ({
      id: task.spec.id,
      result: task.result,
      review: task.review,
    })),
    workflow: workflowEvidence(run),
    evidence: run.finalEvidence,
    previousReview: latestReview(run),
  };
  return Object.fromEntries(
    Object.entries(files)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => {
        const path = join(directory, `${name}.json`);
        writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
        return [name, path];
      }),
  );
}
