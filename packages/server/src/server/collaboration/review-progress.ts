import {
  ReviewSchema,
  collaborationMode,
  hasFinalResult,
  type Operation,
  type Review,
  type Run,
} from "@getpaseo/protocol/collaboration/schema";
import type {
  AcceptanceReport,
  ReviewProgress,
} from "@getpaseo/protocol/collaboration/presentation";

function completedReviews(run: Run) {
  const lastPlan = run.operations.findLastIndex((op) => op.kind === "plan" && op.state === "done");
  const start =
    collaborationMode(run) === "execute_review"
      ? (run.roundOperationOffset ?? 0)
      : Math.max(0, lastPlan);
  return run.operations.slice(start).flatMap((operation) => {
    if (operation.state !== "done" || !["review", "final"].includes(operation.kind)) return [];
    const parsed = ReviewSchema.safeParse(operation.response);
    return parsed.success ? [{ operation, review: parsed.data }] : [];
  });
}

type Finding = Review["findings"][number];

function sameFinding(left: Finding, right: Finding) {
  return (
    left.taskId === right.taskId &&
    left.location === right.location &&
    left.problem === right.problem
  );
}

/** Identities live in accepted operation responses, so retries and host restarts retain them. */
export function identifyReviewFindings(run: Run, operation: Operation, review: Review): Review {
  const saved = [run.finalReview, ...run.tasks.map((task) => task.review)];
  const previous = [
    ...completedReviews(run).flatMap((entry) => entry.review.findings),
    ...saved.flatMap((entry) => entry?.findings ?? []),
  ];
  const used = new Set<string>();
  const ordinal = run.operations.findIndex((entry) => entry.id === operation.id) + 1;
  const findings = review.findings.map((finding, index) => {
    if (!run.tasks.some((task) => task.spec.id === finding.taskId))
      throw new Error(`审核引用未知任务：${finding.taskId}`);
    const existing = finding.id
      ? previous.find((entry) => entry.id === finding.id)
      : previous.findLast((entry) => entry.id && sameFinding(entry, finding));
    if (finding.id && (!existing || existing.taskId !== finding.taskId))
      throw new Error(`审核引用未知或不属于此任务的问题编号：${finding.id}`);
    const id = existing?.id ?? `F${ordinal}-${index + 1}`;
    if (used.has(id)) throw new Error(`审核问题编号重复：${id}`);
    used.add(id);
    return { ...finding, id };
  });
  return { ...review, findings };
}

/** Bounded round summaries; a missing finding is never presented as a verified fix. */
export function reviewProgress(run: Run): ReviewProgress | undefined {
  const reviews = completedReviews(run);
  if (!reviews.length) return;
  const seen = new Set<string>();
  const history = reviews.map(({ review }, index) => {
    let recurring = 0;
    for (const finding of review.findings) {
      if (!finding.id) continue;
      if (seen.has(finding.id)) recurring++;
      seen.add(finding.id);
    }
    const identified = review.findings.every((finding) => !!finding.id);
    return {
      round: index + 1,
      decision: review.decision,
      reported: review.findings.length,
      findings: review.findings,
      ...(identified ? { added: review.findings.length - recurring, recurring } : {}),
    };
  });
  return { rounds: reviews.length, history: history.slice(-5) };
}

export function acceptanceReport(run: Run): AcceptanceReport | undefined {
  if (!hasFinalResult(run) || run.userAcceptance) return;
  const review = run.finalReview;
  const evidence = run.finalEvidence;
  if (!review || !evidence || review.artifactId !== evidence.id) return;
  return {
    review,
    changedFiles: evidence.changedFiles,
    checks: evidence.checks.map(({ label, exitCode }) => ({ label, exitCode })),
    tasks: run.tasks.flatMap((task) =>
      task.result
        ? [
            {
              title: task.spec.title,
              summary: task.result.summary,
              tests: task.result.tests,
              issues: task.result.issues,
            },
          ]
        : [],
    ),
  };
}
