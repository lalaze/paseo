import { z } from "zod";

export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const CollaborationModeSchema = z.enum(["full", "execute_review"]);
export type CollaborationMode = z.infer<typeof CollaborationModeSchema>;
export const CollaborationIsolationSchema = z.enum(["local", "worktree"]);
export type CollaborationIsolation = z.infer<typeof CollaborationIsolationSchema>;

export function collaborationMode(value: { mode?: CollaborationMode }): CollaborationMode {
  // COMPAT(collaborationExecuteReview): added in v0.9.0, remove after 2027-03-23 once stored conversations and runs carry mode.
  return value.mode ?? "full";
}

export function requiresPlanApproval(run: Pick<Run, "mode" | "settings">): boolean {
  return collaborationMode(run) === "full" && run.settings.requirePlanApproval;
}

export function validateCollaborationMode(mode: CollaborationMode, settings: Settings): void {
  if (mode === "execute_review" && !settings.reviewerProfileId)
    throw new Error("执行＋审核模式需要独立审核 Agent，请先在协作设置中指定审核 Agent");
}
const Text = z.string().trim().min(1).max(16000);
export const InstructionTextSchema = z.string().max(8000);
export const RolePromptsSchema = z.object({
  plan: InstructionTextSchema.optional(),
  execute: InstructionTextSchema.optional(),
  review: InstructionTextSchema.optional(),
});
export type RolePrompts = z.infer<typeof RolePromptsSchema>;
export const ProfileSchema = z.object({
  id: Id,
  label: z.string().min(1).max(120),
  provider: z.string().regex(/^[^/\s]+\/.+$/, "请选择供应商和模型"),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  transport: z.enum(["structured", "mcp"]).default("structured"),
  instructions: InstructionTextSchema.optional(),
});
/** Model choice for an execution handoff. It cannot carry a role prompt or a task assignment. */
export const ExecutionModelSchema = ProfileSchema.pick({
  provider: true,
  thinkingOptionId: true,
  featureValues: true,
}).strict();
export type ExecutionModel = z.infer<typeof ExecutionModelSchema>;
export const EXECUTION_FALLBACK_LIMIT = 8;
export const CommandSchema = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(1000),
  args: z.array(z.string()).max(80).default([]),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
});
export const SettingsSchema = z
  .object({
    profiles: z.array(ProfileSchema).min(1).max(30),
    directorProfileId: Id,
    workerProfileId: Id,
    /** Omitted means review in the original design session, preserving old settings. */
    reviewerProfileId: Id.optional(),
    /** The reviewer owns the main conversation, including planning when enabled. */
    reviewerAsLead: z.boolean().optional(),
    rolePrompts: RolePromptsSchema.optional(),
    categoryOverrides: z.record(z.string(), Id).default({}),
    taskOverrides: z.record(z.string(), Id).default({}),
    allowDirectorSelection: z.boolean().default(false),
    // COMPAT(collaborationCountLimits): added in v0.11.1, retain ignored count fields until older clients are retired after 2027-04-14.
    maxReworks: z.number().int().min(0).max(10).default(2),
    maxAttempts: z.number().int().min(3).max(200).default(40),
    turnTimeoutMs: z.number().int().min(1000).max(7200000).default(1800000),
    runTimeoutMs: z.number().int().min(1000).max(86400000).default(14400000),
    requirePlanApproval: z.boolean().default(false),
    verificationCommands: z.array(CommandSchema).max(12).default([]),
    /**
     * Ordered backup models keyed by the logical execution profile.
     * Absent or empty disables automatic handoff for that profile.
     */
    executionFallbacks: z
      .record(z.string(), z.array(ExecutionModelSchema).max(EXECUTION_FALLBACK_LIMIT))
      .optional(),
  })
  .superRefine((s, ctx) => {
    if (s.reviewerAsLead && s.reviewerProfileId !== s.directorProfileId)
      ctx.addIssue({ code: "custom", message: "主 Agent 必须使用审核 Agent 配置" });
    const ids = new Set(s.profiles.map((p) => p.id));
    if (ids.size !== s.profiles.length)
      ctx.addIssue({ code: "custom", message: "AI 配置 ID 不能重复" });
    for (const id of [
      s.directorProfileId,
      s.workerProfileId,
      ...(s.reviewerProfileId ? [s.reviewerProfileId] : []),
      ...Object.values(s.categoryOverrides),
      ...Object.values(s.taskOverrides),
    ]) {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `不存在的 AI 配置：${id}` });
    }
    for (const [profileId, models] of Object.entries(s.executionFallbacks ?? {})) {
      if (!Id.safeParse(profileId).success || !ids.has(profileId))
        ctx.addIssue({ code: "custom", message: `备用模型引用了不存在的 AI 配置：${profileId}` });
      const profile = s.profiles.find((candidate) => candidate.id === profileId);
      const seen = new Set<string>();
      for (const model of models) {
        if (seen.has(model.provider))
          ctx.addIssue({ code: "custom", message: `备用模型重复：${model.provider}` });
        seen.add(model.provider);
        if (profile && model.provider === profile.provider)
          ctx.addIssue({
            code: "custom",
            message: `备用模型不能与当前执行模型相同：${model.provider}`,
          });
      }
    }
  });
export const TaskSchema = z.object({
  id: Id,
  title: Text,
  description: Text,
  category: z.string().min(1).max(80),
  dependsOn: z.array(Id).max(30),
  files: z.array(z.string().min(1).max(1000)).min(1).max(100),
  acceptance: z.array(Text).min(1).max(30),
  executorId: Id.optional(),
});
export const PlanSchema = z.object({
  summary: Text,
  architecture: Text,
  acceptance: z.array(Text).min(1).max(30),
  tasks: z.array(TaskSchema).min(1).max(30),
});
export const ResultSchema = z.object({
  status: z.enum(["ready_for_review", "blocked"]),
  summary: Text,
  tests: z.array(Text).max(30),
  issues: z.array(Text).max(30),
});
export const ReviewSchema = z
  .object({
    decision: z.enum(["approved", "changes_requested", "blocked"]),
    artifactId: z.string().min(1),
    summary: Text,
    criteria: z
      .array(z.object({ criterion: Text, passed: z.boolean(), evidence: Text }))
      .min(1)
      .max(930),
    findings: z
      .array(
        z.object({ taskId: Id, location: Text, problem: Text, change: Text, verification: Text }),
      )
      .max(60),
  })
  .superRefine((r, ctx) => {
    if (
      r.decision === "approved" &&
      (r.findings.length ||
        r.criteria.some((candidateConversation) => !candidateConversation.passed))
    ) {
      ctx.addIssue({ code: "custom", message: "存在未通过项或修改要求时不能批准" });
    }
    if (r.decision === "changes_requested" && !r.findings.length)
      ctx.addIssue({ code: "custom", message: "返工必须提供具体修改要求" });
  });
export type Profile = z.infer<typeof ProfileSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type Command = z.infer<typeof CommandSchema>;

export interface Evidence {
  id: string;
  tree: string;
  diffPath: string;
  changedFiles: string[];
  diff: string;
  checks: { label: string; exitCode: number | null; logPath: string; output: string }[];
  passed: boolean;
  capturedAt: number;
  /** Changes since the preceding review snapshot, including deleted and untracked files. */
  delta?: { baseArtifactId: string; diffPath: string; changedFiles: string[] };
  verificationStatus?: "not_configured" | "passed" | "failed";
}
export interface Operation {
  id: string;
  kind: "plan" | "execute" | "review" | "final";
  taskId?: string;
  profileId: string;
  agentId?: string;
  state: "pending" | "creating" | "ready" | "sending" | "sent" | "done" | "abandoned";
  prompt: string;
  createdAt: number;
  sentAt?: number;
  deliveryConfirmedAt?: number;
  completedAt?: number;
  observedBusy?: boolean;
  response?: unknown;
  responseHash?: string;
  formatRetries: number;
  /** Immutable review baseline; kept when rework clears the current evidence. */
  reviewArtifact?: { id: string; tree: string };
  /** Provider-reported usage per turn; absent metrics are unknown, never zero estimates. */
  usage?: {
    turnId: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
  }[];
  usageTurnIds?: string[];
  /** New unified reviews cover both plan and task criteria; absent on legacy operations. */
  reviewScope?: "all_tasks";
  /** Model frozen for this operation. Absent means the logical profile's model. */
  executionModel?: ExecutionModel;
  /** The session was replaced after a quota handoff and must not be reused. */
  superseded?: boolean;
  /** Recorded when this operation was replaced by another model. */
  handoff?: {
    at: number;
    source: "automatic" | "manual";
    errorClass: "quota";
    target: ExecutionModel;
    fromModel?: ExecutionModel;
  };
}
export type AgentRole = "director" | "worker" | "reviewer";
// Task IDs cannot contain ':', so this actor cannot collide with a legacy task.
export const REVIEWER_ACTOR = "role:reviewer";
export function operationRole(settings: Settings, kind: Operation["kind"]): AgentRole {
  if (kind === "execute") return "worker";
  if (kind === "plan" || settings.reviewerAsLead || !settings.reviewerProfileId) return "director";
  return "reviewer";
}
export function operationLabel(settings: Settings, kind: Operation["kind"]): string {
  if (settings.reviewerAsLead && kind !== "execute")
    return kind === "plan" ? "主 Agent" : "审核 AI";
  const role = operationRole(settings, kind);
  if (role === "worker") return "执行 AI";
  if (role === "reviewer") return "审核 AI";
  return settings.reviewerProfileId ? "设计 AI" : "总 AI";
}

export interface UserAcceptance {
  decision: "approved" | "rejected";
  artifactId: string;
  decidedAt: number;
}
export interface ChangeRequest {
  requestedAt: number;
  feedback: string;
  planVersion: number;
  artifactId: string;
  previousPlan: Plan;
  previousReview: Review;
  previousAcceptance?: UserAcceptance;
  previousTasks: { id: string; profileId: string; agentId?: string; result?: Result }[];
}
export interface FinalControl {
  feedback?: string;
  artifactId?: string;
  expectedRevision?: number;
}
export type ControlAction =
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "approve_plan"
  | "revise"
  | "accept_final"
  | "reject_final"
  | "request_changes"
  | "note";

interface ExecutionRelayBase {
  source: "automatic" | "manual" | "none";
  operationId: string;
  taskId: string;
  profileId: string;
  agentId?: string;
  errorClass: "quota";
  message: string;
  attempted: ExecutionModel[];
  /** The user may choose another model. Set only for an explicit quota block. */
  manual: boolean;
  token: number;
  at: number;
  requestId?: string;
}
export type ExecutionRelay =
  | (ExecutionRelayBase & { status: "blocked" })
  | (ExecutionRelayBase & { status: "stopping"; target: ExecutionModel })
  | (ExecutionRelayBase & { status: "preparing"; target: ExecutionModel; handoff: string })
  | (ExecutionRelayBase & { status: "failed"; reason: string; target?: ExecutionModel });

export interface Run {
  mode?: CollaborationMode;
  id: string;
  requestId: string;
  revision: number;
  goal: string;
  repository: string;
  cwd: string;
  baseCommit: string;
  branch: string;
  /** Local branch selected before collaboration prepared its result branch. */
  sourceBranch?: string;
  delivery?:
    | { status: "merging" }
    | { status: "failed"; error: string; recovery?: { sourceMessageId: string } }
    | { status: "merged"; targetBranch: string; cwd: string; commit: string };
  settings: Settings;
  /** Absent on legacy runs, which use an isolated worktree. */
  workspaceId?: string;
  chat?: {
    version: 1;
    conversationId: string;
    mainAgentId: string;
    legacyAgentId?: string;
    recovering?: boolean;
  };
  migrationConversationId?: string;
  chatReceipts?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  directorAgentId?: string;
  reviewerAgentId?: string;
  phase:
    | "planning"
    | "executing"
    | "reviewing"
    | "final_review"
    | "awaiting_acceptance"
    | "completed";
  control:
    | "running"
    | "paused"
    | "waiting_permission"
    | "needs_attention"
    | "canceling"
    | "canceled";
  message: string;
  plan?: Plan;
  planApproved: boolean;
  planApprovedAt?: number;
  stopTarget?: "canceled" | "needs_attention";
  planVersion?: number;
  dispatchOrder?: string[];
  userAcceptance?: UserAcceptance;
  changeRequests?: ChangeRequest[];
  /** Additions the user made during the run without changing the goal; every later step follows them. */
  notes?: { text: string; at: number }[];
  /** Explicit user-requested rounds get their own bounded execution budget. */
  roundStartedAt?: number;
  /** Running time since the user last set the run going; paused and waiting time is free. */
  budgetUsedMs?: number;
  /** When the run last started running; absent while it is not running. */
  runningSince?: number;
  roundOperationOffset?: number;
  /** A transient provider failure retries by itself; `at` is when the next attempt starts. */
  autoRetry?: { attempts: number; at?: number };
  /** Actual model now used for a logical execution profile after a successful handoff. */
  executionModels?: Record<string, ExecutionModel>;
  /** Providers already consumed by the current quota chain. A success clears the profile entry. */
  executionAttempts?: Record<string, ExecutionModel[]>;
  /** Quota handoff in progress or waiting. Pause and cancel still live on `control`. */
  executionRelay?: ExecutionRelay;
  relayToken?: number;
  /** Manual switch requests. The same request id cannot dispatch twice. */
  relayReceipts?: Record<string, { provider: string; fingerprint: string; operationId?: string }>;
  tasks: {
    spec: Task;
    profileId: string;
    status: "pending" | "executing" | "executed" | "reviewing" | "approved";
    reworks: number;
    agentId?: string;
    feedback?: string;
    result?: Result;
    evidence?: Evidence;
    review?: Review;
  }[];
  operations: Operation[];
  activeOperationId?: string;
  finalEvidence?: Evidence;
  finalReview?: Review;
  events: { time: number; message: string }[];
}
/** Legacy completed runs can still be accepted or revised by their user. */
export function hasFinalResult(run: Run): boolean {
  return (
    ["awaiting_acceptance", "completed"].includes(run.phase) &&
    ["paused", "running"].includes(run.control) &&
    (run.finalReview?.decision === "approved" ||
      run.finalReview?.decision === "changes_requested") &&
    !!run.finalEvidence &&
    !run.activeOperationId
  );
}
export function awaitingAcceptance(run: Run): boolean {
  return hasFinalResult(run) && !run.userAcceptance;
}
export function executionComplete(task: Run["tasks"][number]): boolean {
  return task.status === "executed" || task.status === "approved";
}
export function finalAcceptance(plan: Plan): string[] {
  return [...new Set([...plan.acceptance, ...plan.tasks.flatMap((task) => task.acceptance)])];
}
/** Planning can resume before a plan exists; a saved plan still needs approval. */
export function canResumeRun(run: Run): boolean {
  return (
    !["completed", "awaiting_acceptance"].includes(run.phase) &&
    ["paused", "waiting_permission"].includes(run.control) &&
    (!run.plan || run.planApproved)
  );
}
export function acceptanceMessage(run: Run): string {
  if (run.finalReview?.decision === "changes_requested")
    return `${operationLabel(run.settings, "final")}仍要求修改；请查看审核意见后验收、不采纳或提出修改意见`;
  return `${operationLabel(run.settings, "final")}最终审核通过，等待你验收或提出修改意见`;
}
export interface ExecutionRelayView {
  status: ExecutionRelay["status"];
  source: ExecutionRelay["source"];
  operationId: string;
  taskId?: string;
  profileId: string;
  errorClass: "quota";
  message: string;
  manual: boolean;
  token: number;
  target?: ExecutionModel;
  attempted: ExecutionModel[];
  reason?: string;
}
export interface ExecutionView {
  profileId: string;
  model?: ExecutionModel;
  relay?: ExecutionRelayView;
}
export type RunSummary = Pick<
  Run,
  "id" | "goal" | "cwd" | "phase" | "control" | "message" | "createdAt" | "updatedAt"
> & {
  done: number;
  total: number;
  mode?: CollaborationMode;
  deliveryStatus?: NonNullable<Run["delivery"]>["status"];
  execution?: ExecutionView;
};
export function executionView(run: Run): ExecutionView | undefined {
  const relay = run.executionRelay;
  const active = run.operations.find((operation) => operation.id === run.activeOperationId);
  const profileId = relay?.profileId ?? (active?.kind === "execute" ? active.profileId : undefined);
  const override = profileId ? run.executionModels?.[profileId] : undefined;
  if (!relay && !override) return undefined;
  if (!profileId) return undefined;
  const model = override ?? active?.executionModel;
  const view: ExecutionView = {
    profileId,
    ...(model ? { model } : {}),
  };
  if (!relay) return view;
  view.relay = {
    status: relay.status,
    source: relay.source,
    operationId: relay.operationId,
    taskId: relay.taskId,
    profileId: relay.profileId,
    errorClass: relay.errorClass,
    message: relay.message,
    manual: relay.manual,
    token: relay.token,
    attempted: relay.attempted,
    ...("target" in relay && relay.target ? { target: relay.target } : {}),
    ...("reason" in relay && relay.reason ? { reason: relay.reason } : {}),
  };
  return view;
}
export function summarize(run: Run): RunSummary {
  const { id, goal, cwd, phase, control, message, createdAt, updatedAt } = run;
  const waiting = awaitingAcceptance(run);
  const execution = executionView(run);
  return {
    id,
    mode: collaborationMode(run),
    goal,
    cwd,
    phase: waiting ? "awaiting_acceptance" : phase,
    control: waiting ? "paused" : control,
    message: waiting ? acceptanceMessage(run) : message,
    createdAt,
    updatedAt,
    done: run.tasks.filter(executionComplete).length,
    total: run.tasks.length,
    deliveryStatus: run.delivery?.status,
    ...(execution ? { execution } : {}),
  };
}
export function profileForTask(settings: Settings, task: Task): string {
  return (
    settings.taskOverrides[task.id] ??
    settings.categoryOverrides[task.category] ??
    (settings.allowDirectorSelection ? task.executorId : undefined) ??
    settings.workerProfileId
  );
}
export function validatePlan(plan: Plan, settings: Settings): void {
  const map = new Map(plan.tasks.map((candidateEntry) => [candidateEntry.id, candidateEntry]));
  if (map.size !== plan.tasks.length) throw new Error("任务 ID 重复");
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Error("任务依赖存在循环");
    if (visited.has(id)) return;
    const task = map.get(id);
    if (!task) throw new Error(`不存在的前置任务：${id}`);
    active.add(id);
    task.dependsOn.forEach(visit);
    active.delete(id);
    visited.add(id);
  }
  for (const task of plan.tasks) {
    if (task.id === "director") throw new Error("director 是保留角色 ID，不能作为任务 ID");
    visit(task.id);
    if (!settings.profiles.some((p) => p.id === profileForTask(settings, task)))
      throw new Error(`任务 ${task.id} 指定了未知 AI`);
    if (task.files.some((f) => f.startsWith("/") || f.split(/[\\/]/).includes("..")))
      throw new Error("修改范围必须是工作区内的相对路径");
  }
}
export function parseOutput(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* Providers may wrap their final JSON in a fenced block. */
  }
  const blocks = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (blocks.length) {
    const last = blocks.at(-1)!;
    if (!trimmed.slice(last.index! + last[0].length).trim()) return JSON.parse(last[1]);
  }
  // Earlier progress messages may precede a plain final JSON response. Only
  // accept a complete top-level object at the end, never a nested fragment.
  let depth = 0,
    inString = false,
    escaped = false,
    start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (depth === 0) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0 && !trimmed.slice(i + 1).trim())
      return JSON.parse(trimmed.slice(start, i + 1));
  }
  throw new Error("请通过指定工具提交结果，或只输出一个 JSON 对象");
}
