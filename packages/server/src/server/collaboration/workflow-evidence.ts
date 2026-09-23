import {
  ReviewSchema,
  collaborationMode,
  requiresPlanApproval,
  type Run,
} from "@getpaseo/protocol/collaboration/schema";

const timestamp = (value?: number) => (value === undefined ? null : new Date(value).toISOString());

/** Project scheduler-owned checkpoints; never expose prompts, MCP tokens or credentials. */
export function workflowEvidence(run: Run) {
  const planIndex = run.operations.findLastIndex((op) => op.kind === "plan" && op.state === "done");
  const startIndex =
    collaborationMode(run) === "execute_review"
      ? (run.roundOperationOffset ?? 0)
      : Math.max(0, planIndex);
  const operations = run.operations.slice(startIndex);
  const planStartedAt = operations[0]?.createdAt ?? run.createdAt;
  const events = run.events.filter((event) => event.time >= planStartedAt);
  const legacyApproval = events.findLast((event) => event.message === "总纲已批准");
  const userApprovedAt =
    requiresPlanApproval(run) && run.planApproved
      ? (run.planApprovedAt ?? legacyApproval?.time)
      : undefined;
  let timestampSource = "unavailable";
  if (userApprovedAt !== undefined)
    timestampSource = run.planApprovedAt !== undefined ? "checkpoint" : "legacy_event";
  return {
    source: "Paseo Director 持久化调度记录",
    runId: run.id,
    mode: collaborationMode(run),
    planVersion: run.planVersion ?? 1,
    planApproval: {
      required: requiresPlanApproval(run),
      applicable: collaborationMode(run) === "full",
      approved: run.planApproved,
      userApprovedAt: timestamp(userApprovedAt),
      timestampSource,
    },
    operations: operations.map((candidateOperation) => {
      const review =
        ["review", "final"].includes(candidateOperation.kind) && candidateOperation.state === "done"
          ? ReviewSchema.safeParse(candidateOperation.response)
          : undefined;
      return {
        operationId: candidateOperation.id,
        kind: candidateOperation.kind,
        taskId: candidateOperation.taskId ?? null,
        profileId: candidateOperation.profileId,
        agentId: candidateOperation.agentId ?? null,
        state: candidateOperation.state,
        queuedAt: timestamp(candidateOperation.createdAt),
        sendRequestedAt: timestamp(candidateOperation.sentAt),
        deliveryConfirmedAt: timestamp(candidateOperation.deliveryConfirmedAt),
        resultAcceptedAt: timestamp(candidateOperation.completedAt),
        reviewDecision: review?.success ? review.data.decision : null,
        artifactId: review?.success ? review.data.artifactId : null,
      };
    }),
    // Old versions retained milestone times in the event log. Keep those facts
    // available without inventing missing checkpoint timestamps for old runs.
    events: events
      .filter(
        (event) =>
          event.message === "总纲已批准" ||
          event.message.startsWith("审核通过：") ||
          event.message.startsWith("已发送") ||
          event.message.startsWith("执行完成"),
      )
      .map((event) => ({ time: timestamp(event.time), message: event.message })),
  };
}
