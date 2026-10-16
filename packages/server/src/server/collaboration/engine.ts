import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  SettingsSchema,
  collaborationMode,
  type CollaborationIsolation,
  requiresPlanApproval,
  validateCollaborationMode,
  PlanSchema,
  ResultSchema,
  ReviewSchema,
  hasFinalResult,
  canResumeRun,
  executionComplete,
  finalAcceptance,
  parseOutput,
  profileForTask,
  validatePlan,
  operationRole,
  operationLabel,
  REVIEWER_ACTOR,
  type Run,
  type Operation,
  type Settings,
  type Profile,
  type Review,
  type ControlAction,
  type FinalControl,
  type Evidence,
  type CollaborationMode,
  type ExecutionModel,
  type ExecutionRelay,
} from "@getpaseo/protocol/collaboration/schema";
import type { Repository } from "./repository.js";
import { Store } from "./store.js";
import { buildPrompt, CONTINUED_SESSION_NOTE, responseSchema } from "./prompts.js";
import {
  classifyProviderFailure,
  isProviderTerminalOutput,
  isTransientProviderError,
  providerFailureEvidence,
} from "./provider-failure.js";
import { rememberAttempt, renderHandoffPackage, sameExecutionModel } from "./handoff.js";

export { isTransientProviderError } from "./provider-failure.js";

export interface AgentSnapshot {
  status: "idle" | "running" | "permission" | "error" | "missing";
  seen: boolean;
  output: string;
  interrupted?: boolean;
  error?: string;
  /** Real run ownership. `lifecycle === "error"` alone does not mean the turn has stopped. */
  ownership?: { inFlight: boolean; pendingPermissions: number; lifecycle: string };
  failure?: { code?: string; diagnostic?: string };
  /** When the session last showed activity (epoch ms). */
  activeAt?: number;
  /** `REPEATED_SHELL_CALL_LIMIT` identical completed shell calls within the repetition window. */
  hasRepeatedShellCalls?: boolean;
}
export interface AgentGateway {
  workspaceDirectory(workspaceId: string): Promise<string>;
  retainWorkspaceName(workspaceId: string): Promise<void>;
  create(run: Run, op: Operation, profile: Profile): Promise<string>;
  find(runId: string, operationId: string): Promise<string[]>;
  /** `since` (epoch ms) bounds how far back history is searched for the marker. */
  inspect(agentId: string, operationId: string, since?: number): Promise<AgentSnapshot>;
  send(agentId: string, operationId: string, prompt: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  /** Catalog and tool check only. Must not send an authentication request. */
  validateExecutionModel(model: ExecutionModel): Promise<void>;
  /** Bounded assistant and tool evidence. Thoughts and credentials stay out. */
  handoffActivity(
    agentId: string,
    operationId: string,
  ): Promise<{ text: string; truncated: boolean; missing: boolean }>;
}

const AUTO_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
/** An execution session repeating one completed shell call this often in the window is stopped. */
export const REPEATED_SHELL_CALL_LIMIT = 12;
export const REPEATED_SHELL_CALL_WINDOW_MS = 120_000;

function sessionSettled(state: AgentSnapshot): boolean {
  if (state.ownership)
    return (
      !state.ownership.inFlight &&
      state.ownership.pendingPermissions === 0 &&
      state.ownership.lifecycle !== "initializing" &&
      state.ownership.lifecycle !== "running"
    );
  return state.status !== "running" && state.status !== "permission";
}

export class Engine {
  private locks = new Map<string, Promise<unknown>>();
  private checks = new Map<string, AbortController>();
  private stopped = false;
  constructor(
    readonly store: Store,
    private agents: AgentGateway,
    private repository: Repository,
    private now = () => Date.now(),
  ) {}
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
  private event(run: Run, message: string) {
    run.message = message;
    run.events.push({ time: this.now(), message });
    run.events = run.events.slice(-300);
  }
  async create(input: {
    requestId: string;
    repository: string;
    goal: string;
    settings?: Settings;
    workspaceId?: string;
    /** `worktree` creates a Paseo worktree. Absent or `local` keeps this workspace. */
    isolation?: CollaborationIsolation;
    chat?: Run["chat"];
    mode?: CollaborationMode;
  }): Promise<string> {
    // Serialize preparation so concurrent requests cannot switch one checkout
    // to different branches before either run is recorded.
    return this.locked("create", async () => {
      const existing = this.store.findRequest(input.requestId);
      if (existing) return existing.id;
      const settings = SettingsSchema.parse(input.settings ?? this.store.settings());
      const mode = collaborationMode(input);
      validateCollaborationMode(mode, settings);
      const id = createHash("sha256").update(input.requestId).digest("hex").slice(0, 24);
      const isolate = input.isolation === "worktree";
      if (input.workspaceId) {
        const directory = await this.agents.workspaceDirectory(input.workspaceId);
        const source = await realpath(input.repository);
        if (source !== (await realpath(directory)))
          throw new Error("项目路径与当前工作区不一致，请使用当前目录或选择独立工作区");
        if (
          this.store
            .unfinishedWorkspaceRuns()
            .some((r) => r.cwd === source || (!isolate && r.workspaceId === input.workspaceId))
        )
          throw new Error("当前目录已有未结束的 AI 协作任务，请先完成或取消该任务");
        // Untitled Paseo workspaces derive their name from the live branch.
        // Pin the existing display name before prepare() switches that branch.
        if (!isolate) await this.agents.retainWorkspaceName(input.workspaceId);
      }
      const workspace = await this.repository.prepare(
        input.repository,
        id,
        Boolean(input.workspaceId) && !isolate,
      );
      const run: Run = {
        ...workspace,
        ...(!isolate && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        id,
        ...(input.chat ? { chat: input.chat, directorAgentId: input.chat.mainAgentId } : {}),
        requestId: input.requestId,
        revision: 0,
        goal: input.goal,
        settings,
        mode,
        createdAt: this.now(),
        updatedAt: this.now(),
        phase: "planning",
        control: "running",
        runningSince: this.now(),
        message: `等待${operationLabel(settings, "plan")}制定计划`,
        planApproved: !requiresPlanApproval({ mode, settings }),
        tasks: [],
        operations: [],
        events: [],
      };
      if (mode === "execute_review") this.initializeDirectExecution(run);
      this.store.insert(run);
      return id;
    });
  }
  private initializeDirectExecution(run: Run, agentId?: string) {
    // Reuse task/evidence checkpoints without asking an AI to manufacture a design.
    // Goals allow 32k characters; each existing criterion allows 16k. Preserve the whole goal.
    const acceptance = ["逐项满足完整用户目标（goal）及所有仍有效的修改要求，并提供实际验证证据"];
    for (let offset = 0; offset < run.goal.length; offset += 16000) {
      const requirement = run.goal.slice(offset, offset + 16000).trim();
      if (requirement) acceptance.push(requirement);
    }
    const feedback = run.changeRequests?.at(-1)?.feedback;
    if (feedback) acceptance.push(feedback);
    const spec = {
      id: "task-1",
      title: "执行用户目标",
      description:
        "直接实施 goal 中的完整要求及 userChangeRequests 中仍有效的修改要求，不拆分任务。",
      category: "implementation",
      files: ["."],
      dependsOn: [],
      acceptance,
    };
    run.plan = {
      summary: "执行＋审核",
      architecture: "由执行 Agent 在当前工作区完成目标，再交独立审核 Agent 验证。",
      acceptance,
      tasks: [spec],
    };
    run.tasks = [
      { spec, profileId: run.settings.workerProfileId, status: "pending", reworks: 0, agentId },
    ];
    run.planApproved = true;
    run.planApprovedAt = undefined;
    run.phase = "executing";
    this.event(run, "执行＋审核：准备直接执行用户目标");
  }
  async close() {
    this.stopped = true;
    for (const controller of this.checks.values()) controller.abort();
    await Promise.allSettled(this.locks.values());
  }
  async tick() {
    if (this.stopped) return;
    const runs = this.store.pending();
    const results = await Promise.allSettled(
      runs
        .filter((r) => !this.locks.has(r.id))
        .map((r) => this.locked(r.id, () => this.advance(r.id))),
    );
    for (const [index, outcome] of results.entries())
      if (outcome.status === "rejected")
        console.error(
          `Director run ${runs[index].id}:`,
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        );
  }
  /** Every run save goes through here so running time is metered at each control change. */
  private save(run: Run) {
    const now = this.now();
    const running =
      run.control === "running" && !["awaiting_acceptance", "completed"].includes(run.phase);
    if (running) run.runningSince ??= now;
    else if (run.runningSince !== undefined) {
      run.budgetUsedMs = (run.budgetUsedMs ?? 0) + Math.max(0, now - run.runningSince);
      run.runningSince = undefined;
    }
    this.store.save(run);
  }
  // Runs saved before metering existed start with an empty budget.
  private budgetExhausted(run: Run): boolean {
    const running = run.runningSince === undefined ? 0 : this.now() - run.runningSince;
    return (run.budgetUsedMs ?? 0) + running >= run.settings.runTimeoutMs;
  }
  /**
   * The budget bounds running without the user, so it starts over whenever the user sets the run
   * going again. Otherwise a run continued near the limit stops again within minutes.
   */
  private renewBudget(run: Run) {
    run.budgetUsedMs = 0;
    run.runningSince = undefined;
  }
  private hold(run: Run, message: string) {
    run.control = "needs_attention";
    this.event(run, message);
    this.save(run);
  }
  /** Forget evidence the run no longer shows; its files are removed in the background. */
  private release(...evidence: (Evidence | undefined)[]) {
    for (const item of evidence)
      if (item)
        void this.repository
          .discard(item)
          .catch((error) =>
            console.error(
              "Director artifacts:",
              error instanceof Error ? error.message : String(error),
            ),
          );
  }
  private current(run: Run) {
    return run.operations.find((o) => o.id === run.activeOperationId);
  }
  private actor(run: Run, op: Operation): string {
    const role = operationRole(run.settings, op.kind);
    if (role === "worker") return op.taskId!;
    return role === "reviewer" ? REVIEWER_ACTOR : "director";
  }
  private describe(run: Run, op: Operation) {
    const actor = operationLabel(run.settings, op.kind);
    const action = { plan: "设计", execute: "执行", final: "统一审核", review: "审核" }[op.kind];
    const title = run.tasks.find((candidateEntry) => candidateEntry.spec.id === op.taskId)?.spec
      .title;
    return { actor, action, detail: title ? `：${title}` : "" };
  }
  private enqueue(
    run: Run,
    kind: Operation["kind"],
    taskId?: string,
    formatRetries = 0,
    handoff?: string,
  ) {
    const task = run.tasks.find((candidateEntry) => candidateEntry.spec.id === taskId);
    if (kind === "final" && (!run.tasks.length || !run.tasks.every(executionComplete)))
      throw new Error("全部任务执行完成后才能统一审核");
    const id = randomUUID();
    const role = operationRole(run.settings, kind);
    const profileId = {
      worker: task?.profileId,
      reviewer: run.settings.reviewerProfileId,
      director: run.settings.directorProfileId,
    }[role]!;
    const replaced = this.replacedAgentIds(run);
    let agentId = {
      worker: task?.agentId ?? this.workerSession(run, profileId),
      reviewer: run.reviewerAgentId,
      director: run.directorAgentId,
    }[role];
    if (role === "worker" && agentId && replaced.has(agentId))
      agentId = this.workerSession(run, profileId);
    if (role === "worker" && agentId && replaced.has(agentId)) agentId = undefined;
    const op: Operation = {
      id,
      kind,
      taskId,
      state: "pending",
      profileId,
      agentId,
      createdAt: this.now(),
      formatRetries,
      prompt: buildPrompt(run, kind, id, taskId, { agentId, handoff }),
    };
    if (kind === "execute") op.executionModel = this.executionModelFor(run, profileId);
    if (kind === "final") op.reviewScope = "all_tasks";
    run.operations.push(op);
    run.activeOperationId = id;
    const { actor, action, detail } = this.describe(run, op);
    this.event(run, `准备交给${actor}${action}${detail}`);
    this.save(run);
  }

  /**
   * Tasks run serially in one workspace, so a profile's worker session carries over to its next
   * task and across revised requirements, keeping the environment, scripts and data it built.
   */
  private replacedAgentIds(run: Run) {
    return new Set(
      run.operations.flatMap((candidate) =>
        candidate.superseded && candidate.agentId ? [candidate.agentId] : [],
      ),
    );
  }
  private profileExecutionModel(run: Run, profileId: string): ExecutionModel {
    const profile = run.settings.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`不存在的 AI 配置：${profileId}`);
    return {
      provider: profile.provider,
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
    };
  }
  private executionModelFor(run: Run, profileId: string): ExecutionModel {
    return run.executionModels?.[profileId] ?? this.profileExecutionModel(run, profileId);
  }
  private operationProfile(run: Run, op: Operation): Profile {
    const profile = run.settings.profiles.find((candidate) => candidate.id === op.profileId);
    if (!profile) throw new Error("AI 配置不存在");
    if (!op.executionModel || op.kind !== "execute") return profile;
    const sameProvider = op.executionModel.provider === profile.provider;
    const next: Profile = {
      ...profile,
      provider: op.executionModel.provider,
      modeId: sameProvider ? profile.modeId : undefined,
    };
    if (op.executionModel.thinkingOptionId)
      next.thinkingOptionId = op.executionModel.thinkingOptionId;
    else delete next.thinkingOptionId;
    if (op.executionModel.featureValues) next.featureValues = op.executionModel.featureValues;
    else if (!sameProvider) delete next.featureValues;
    return next;
  }
  private workerSession(run: Run, profileId: string) {
    const replaced = this.replacedAgentIds(run);
    const wanted = this.executionModelFor(run, profileId);
    return run.operations.findLast((candidate) => {
      if (candidate.kind !== "execute" || candidate.profileId !== profileId) return false;
      if (!candidate.agentId || candidate.agentId === run.chat?.mainAgentId) return false;
      if (replaced.has(candidate.agentId)) return false;
      const actual = candidate.executionModel ?? this.profileExecutionModel(run, profileId);
      return sameExecutionModel(actual, wanted);
    })?.agentId;
  }

  /** Sessions a stop interrupts: the active role session, or children a crash left unbound. */
  private async sessionsToStop(run: Run, op: Operation | undefined) {
    if (op?.state === "creating" && !op.agentId) return this.agents.find(run.id, op.id);
    // The main conversation is the user's own chat; stopping the run leaves its turn alone.
    if (op?.agentId && op.agentId !== run.chat?.mainAgentId) return [op.agentId];
    return [];
  }

  // Timeouts stop the AI before offering retry, so a retry cannot overlap the old turn. A stop
  // can return before the turn settles; the next tick checks again.
  private async reconcileCancellation(run: Run, op: Operation | undefined) {
    if (op)
      for (const agentId of await this.sessionsToStop(run, op)) {
        await this.agents.stop(agentId);
        const state = await this.agents.inspect(agentId, op.id, op.createdAt);
        if (!sessionSettled(state)) return;
      }
    run.control = run.stopTarget ?? "canceled";
    this.event(
      run,
      run.control === "canceled"
        ? "已取消；工作区与成果已保留"
        : `AI 已停止；停止前状态：${run.message}。工作区与成果已保留，可以检查结果后重试`,
    );
    this.save(run);
  }

  // Cancel is final as soon as the user asks: dispatch stops and late submissions are refused.
  // Interrupting the AI afterwards is best effort, so an unusable session cannot hold the run.
  private async interruptCanceled(run: Run) {
    try {
      for (const agentId of await this.sessionsToStop(run, this.current(run)))
        await this.agents.stop(agentId);
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error).slice(0, 3000);
      await this.locked(run.id, async () => {
        const latest = this.store.get(run.id);
        this.event(latest, `已取消；当前 AI 未能停止，可能仍在完成本轮：${reason}`);
        this.save(latest);
      });
    }
  }

  private async enqueueExecution(run: Run) {
    const ready = run.tasks.filter(
      (candidateEntry) =>
        candidateEntry.status === "pending" &&
        candidateEntry.spec.dependsOn.every((dep) => {
          const dependency = run.tasks.find((d) => d.spec.id === dep);
          return dependency && executionComplete(dependency);
        }),
    );
    const task =
      run.dispatchOrder
        ?.map((candidateId) =>
          ready.find((candidateEntry) => candidateEntry.spec.id === candidateId),
        )
        .find(Boolean) ?? ready[0];
    if (task)
      run.dispatchOrder = run.dispatchOrder?.filter((candidateId) => candidateId !== task.spec.id);
    if (task) {
      task.status = "executing";
      this.enqueue(run, "execute", task.spec.id);
    } else if (run.tasks.length && run.tasks.every(executionComplete)) {
      run.phase = "final_review";
      this.event(run, `全部任务已执行，准备交给${operationLabel(run.settings, "final")}统一审核`);
      this.save(run);
    } else throw new Error("没有可以执行的任务，请检查依赖和状态");
  }
  private async enqueueNext(run: Run) {
    await this.repository.assertBranch(run);
    if (run.phase === "planning") this.enqueue(run, "plan");
    else if (run.phase === "executing") {
      await this.enqueueExecution(run);
    } else {
      if (
        run.phase === "final_review" &&
        (!run.tasks.length || !run.tasks.every(executionComplete))
      )
        throw new Error("全部任务执行完成后才能统一审核");
      const task =
        run.phase === "reviewing"
          ? run.tasks.find((candidateEntry) => candidateEntry.status === "reviewing")
          : undefined;
      if (run.phase === "reviewing" && !task) throw new Error("缺少待审核任务");
      const controller = new AbortController();
      this.checks.set(run.id, controller);
      try {
        const evidence = await this.repository.verify(run, controller.signal);
        if (this.stopped) return;
        const previous = task ? task.evidence : run.finalEvidence;
        if (previous && previous.id !== evidence.id) this.release(previous);
        if (task) task.evidence = evidence;
        else run.finalEvidence = evidence;
      } finally {
        this.checks.delete(run.id);
      }
      this.enqueue(run, task ? "review" : "final", task?.spec.id);
    }
    return;
  }

  private async recoverCreation(run: Run, op: Operation) {
    const ids = await this.agents.find(run.id, op.id);
    if (ids.length !== 1) {
      this.hold(run, "创建会话的结果不明确，已停止自动重发；请检查后选择重试");
      return;
    }
    this.bindAgent(run, op, ids[0]);
    this.save(run);
    return;
  }

  private async createOperation(run: Run, op: Operation) {
    await this.repository.assertBranch(run);
    if (op.agentId && op.agentId !== run.chat?.mainAgentId) {
      // A carried-over session can be archived or failed by now; start this step in a fresh one.
      const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
      if (state.status === "missing" || state.status === "error") {
        if (!sessionSettled(state))
          throw new Error("原 AI 仍在执行或等待权限，请先在 Paseo 中处理");
        op.agentId = undefined;
        op.prompt = op.prompt.replace(CONTINUED_SESSION_NOTE, "");
        this.setSession(run, op);
      }
    }
    if (op.agentId) {
      op.state = "ready";
      this.setSession(run, op, op.agentId);
      this.save(run);
      return;
    }
    op.state = "creating";
    this.save(run);
    const profile = this.operationProfile(run, op);
    const agentId = await this.agents.create(run, op, profile);
    this.bindAgent(run, op, agentId);
    this.save(run);
    return;
  }

  private async sendOperation(run: Run, op: Operation) {
    await this.repository.assertBranch(run);
    const before = await this.agents.inspect(op.agentId!, op.id, op.createdAt);
    const { actor, action, detail } = this.describe(run, op);
    if (before.status === "running" || before.status === "permission") {
      const control = before.status === "permission" ? "waiting_permission" : "running";
      const message =
        before.status === "permission"
          ? `${actor}等待权限或回答，${action}指令尚未发送；可在主对话或该 AI 会话中处理`
          : `${actor}仍在完成上一轮，${action}指令尚未发送`;
      if (run.message !== message || run.control !== control) {
        run.control = control;
        this.event(run, message);
        this.save(run);
      }
      return;
    }
    if (before.status === "missing") throw new Error("AI 会话已不存在，请重试以建立替代会话");
    if (before.status === "error") throw new Error(before.error ?? "AI 会话出错，指令尚未发送");
    // Notes added after this step was queued are not in its prompt yet.
    const late = (run.notes ?? []).filter(
      (note) => !op.prompt.includes(JSON.stringify(note.text).slice(1, -1)),
    );
    if (late.length)
      op.prompt += `\nThe user added requirements after this step was queued; they have the same authority as goal:\n${late.map((note) => `- ${note.text}`).join("\n")}`;
    run.control = "running";
    op.state = "sending";
    op.sentAt = this.now();
    this.save(run);
    await this.agents.send(op.agentId!, op.id, op.prompt);
    op.state = "sent";
    op.deliveryConfirmedAt = this.now();
    this.event(run, `已发送${action}指令，等待${actor}开始${detail}`);
    this.save(run);
    return;
  }
  private async collectResult(
    run: Run,
    op: Operation,
    state: AgentSnapshot,
    conversational: boolean,
  ) {
    if (!state.seen && !(conversational && op.response !== undefined)) {
      if (this.now() - (op.sentAt ?? op.createdAt) > 20000)
        throw new Error("当前指令未出现在会话记录中");
      return;
    }
    // A normal reply or canceled chat turn is not an invalid operation result.
    if (conversational && op.response === undefined) return;
    if (op.response === undefined && !state.output.trim()) {
      if (this.now() - (op.sentAt ?? op.createdAt) <= 20000) return;
      if (op.formatRetries >= 2) throw new Error("本轮没有返回任务结果");
      // The turn ended without reporting, often after the work itself is done. Ask the same
      // session to report instead of stopping the run for a manual retry.
      this.retryInSession(
        run,
        op,
        "The previous turn ended without submitting a task result. Inspect completed work, finish what remains and submit the required result; do not repeat completed changes.",
      );
      return;
    }
    let response: unknown;
    try {
      response = responseSchema(op.kind).parse(op.response ?? parseOutput(state.output));
    } catch (error) {
      // Some providers finish a turn by emitting their API failure as assistant text.
      // Sending a format correction to that session only makes another API call.
      if (isProviderTerminalOutput(state.output)) {
        if (await this.handleTerminalFailure(run, op, state)) return;
      }
      if (op.formatRetries >= 2)
        throw new Error(`结果格式连续无效：${String(error).slice(0, 1200)}`, { cause: error });
      this.retryInSession(
        run,
        op,
        `The previous result had an invalid format. Submit the correct format without repeating completed changes. Error: ${String(error).slice(0, 2000)}`,
      );
      return;
    }
    await this.finish(run, op, response);
  }
  /** Re-send the operation to its session with a correction; bounded by `formatRetries`. */
  private retryInSession(run: Run, op: Operation, correction: string) {
    op.state = "abandoned";
    run.activeOperationId = undefined;
    this.enqueue(run, op.kind, op.taskId, op.formatRetries + 1);
    this.current(run)!.prompt += `\n${correction}`;
    this.save(run);
  }
  /**
   * The step limit catches a stuck turn, so it counts from the session's last activity. A step that
   * keeps working runs on until it finishes or the time budget runs out.
   */
  private stepStalled(run: Run, op: Operation, state: AgentSnapshot) {
    const lastActive = Math.max(op.sentAt ?? op.createdAt, state.activeAt ?? 0);
    return this.now() - lastActive >= run.settings.turnTimeoutMs;
  }
  private async observeOperation(run: Run, op: Operation) {
    const state = await this.agents.inspect(op.agentId!, op.id, op.createdAt);
    if (state.status === "missing") throw new Error(state.error ?? "AI 会话不可用");
    if (state.status === "error") {
      if (await this.handleTerminalFailure(run, op, state)) return;
    }
    const conversational = !!run.chat && op.agentId === run.chat.mainAgentId;
    if (state.interrupted && !conversational)
      throw new Error("此会话收到其他消息，已暂停自动处理；请检查后重试当前步骤");
    if (op.state === "sending") {
      if (!state.seen) {
        this.hold(run, "无法确认上一条指令是否送达，已停止自动重发；请检查后重试");
        return;
      }
      op.state = "sent";
      this.save(run);
    }
    if (await this.observeOpenTurn(run, op, state, conversational)) return;
    await this.collectResult(run, op, state, conversational);
  }
  /** Permission, timeout, and an in-flight turn stay on this operation. */
  private async observeOpenTurn(
    run: Run,
    op: Operation,
    state: AgentSnapshot,
    conversational: boolean,
  ) {
    if (state.status === "permission") {
      if (run.control !== "waiting_permission") {
        run.control = "waiting_permission";
        this.event(
          run,
          `${this.describe(run, op).actor}等待权限或回答，可在主对话或该 AI 会话中处理`,
        );
        this.save(run);
      }
      return true;
    }
    const resumed = run.control === "waiting_permission";
    if (resumed) {
      run.control = "running";
      this.event(run, `权限或提问已处理，继续跟进${this.describe(run, op).actor}本轮结果`);
      this.save(run);
    }
    const waitingForTurn =
      state.status === "running" && !(conversational && op.response !== undefined);
    if (!waitingForTurn && !(conversational && op.response === undefined)) return false;
    const repeating =
      !conversational &&
      op.kind === "execute" &&
      op.response === undefined &&
      state.hasRepeatedShellCalls;
    if (repeating) {
      run.control = "canceling";
      run.stopTarget = "needs_attention";
      this.event(
        run,
        `执行 AI 重复空转：${REPEATED_SHELL_CALL_WINDOW_MS / 60_000} 分钟内连续重复同一命令及结果至少 ${REPEATED_SHELL_CALL_LIMIT} 次，正在停止 AI；检查被等待的进程是否已结束，换方法或报告阻碍后重试`,
      );
      this.save(run);
      return true;
    }
    if (this.stepStalled(run, op, state)) {
      run.control = "canceling";
      run.stopTarget = "needs_attention";
      this.event(run, "当前步骤长时间没有进展，正在停止 AI");
      this.save(run);
      return true;
    }
    if (!waitingForTurn) return false;
    if (!op.observedBusy) {
      op.observedBusy = true;
      const { actor, action, detail } = this.describe(run, op);
      if (!resumed && op.response === undefined) this.event(run, `${actor} 正在${action}${detail}`);
      this.save(run);
    }
    return true;
  }
  private async upgradeReview(run: Run, op: Operation | undefined) {
    // Upgrade queued legacy task reviews without discarding a review already
    // sent to an AI. In-flight reviews finish once, then use unified review.
    if (
      run.phase === "reviewing" &&
      (!op || (op.kind === "review" && ["pending", "ready"].includes(op.state)))
    ) {
      const task = run.tasks.find((candidateTask) => candidateTask.status === "reviewing");
      if (!task || task.result?.status !== "ready_for_review")
        throw new Error("缺少已执行的任务成果，无法继续后续任务");
      task.status = "executed";
      if (op) op.state = "abandoned";
      run.activeOperationId = undefined;
      run.phase = "executing";
      this.event(run, "已改为全部任务执行完成后统一审核，继续串行执行后续任务");
      this.save(run);
      return true;
    }
    return false;
  }
  private async advanceOperation(run: Run, op: Operation | undefined) {
    if (!op) return await this.enqueueNext(run);
    if (op.state === "creating") return await this.recoverCreation(run, op);
    if (op.state === "pending") return await this.createOperation(run, op);
    if (!op.agentId) throw new Error("缺少 AI 会话");
    if (op.state === "ready") return await this.sendOperation(run, op);
    await this.observeOperation(run, op);
  }
  /** Cancellation, budget, handoff, review upgrade, and network retry own the tick when set. */
  private async claimAdvance(run: Run, op: Operation | undefined) {
    if (run.control === "canceling") {
      await this.reconcileCancellation(run, op);
      return true;
    }
    if (run.phase === "awaiting_acceptance") return true;
    if (this.budgetExhausted(run)) {
      if (run.executionRelay && ["stopping", "preparing"].includes(run.executionRelay.status))
        run.executionRelay = this.failRelay(run.executionRelay, "时间预算已耗尽");
      run.control = "canceling";
      run.stopTarget = "needs_attention";
      this.event(run, "已用完时间预算，正在停止 AI；继续后会重新计时");
      this.save(run);
      return true;
    }
    if (run.executionRelay && ["stopping", "preparing"].includes(run.executionRelay.status)) {
      await this.continueRelay(run);
      return true;
    }
    if (await this.upgradeReview(run, op)) return true;
    if (run.autoRetry?.at !== undefined) {
      await this.autoRetry(run);
      return true;
    }
    return false;
  }
  private async advance(id: string) {
    let run = this.store.get(id);
    if ((run.migrationConversationId && !run.chat) || run.chat?.recovering) return;
    if (
      this.stopped ||
      run.phase === "completed" ||
      !["running", "waiting_permission", "canceling"].includes(run.control)
    )
      return;
    try {
      const op = this.current(run);
      if (!(await this.claimAdvance(run, op))) await this.advanceOperation(run, op);
    } catch (error) {
      // Re-read after a failed compare-and-swap rather than overwriting another control action.
      run = this.store.get(id);
      const message = String(error instanceof Error ? error.message : error).slice(0, 3000);
      if (this.stopped || run.control === "canceled" || run.phase === "completed") return;
      if (await this.recoverProviderException(run, message)) return;
      if (!this.scheduleAutoRetry(run, message)) this.hold(run, message);
    }
  }
  /**
   * Network and server-side provider failures retry with backoff instead of waiting for the user.
   * A failed stop is not retried: it needs attention like any other failed stop.
   */
  private scheduleAutoRetry(run: Run, message: string) {
    const op = this.current(run);
    const attempts = run.autoRetry?.attempts ?? 0;
    if (
      run.control === "canceling" ||
      !op?.agentId ||
      op.agentId === run.chat?.mainAgentId ||
      attempts >= AUTO_RETRY_DELAYS_MS.length ||
      !isTransientProviderError(message)
    )
      return false;
    const delay = AUTO_RETRY_DELAYS_MS[attempts];
    run.autoRetry = { attempts: attempts + 1, at: this.now() + delay };
    this.event(
      run,
      `AI 服务连接出错，${delay / 1000} 秒后自动重试（第 ${attempts + 1}/${AUTO_RETRY_DELAYS_MS.length} 次）：${message.slice(0, 300)}`,
    );
    this.save(run);
    return true;
  }
  private async autoRetry(run: Run) {
    if (this.now() < run.autoRetry!.at!) return;
    run.autoRetry = { attempts: run.autoRetry!.attempts };
    await this.retryCurrent(run, "自动重试当前步骤");
    this.save(run);
  }
  /** Confirmed execute quota from create/send enters handoff. Anything uncertain stays blocked. */
  private async recoverProviderException(run: Run, message: string) {
    const op = this.current(run);
    if (!this.canHandoffException(run, op, message) || !op) return false;
    if (!(await this.reconcileFailedDelivery(run, op))) return true;
    await this.beginHandoff(run, op, message);
    return true;
  }
  private canHandoffException(run: Run, op: Operation | undefined, message: string) {
    return (
      !!op &&
      op.kind === "execute" &&
      !!op.taskId &&
      !["paused", "canceled", "canceling"].includes(run.control) &&
      classifyProviderFailure({ message, source: "provider" }).handoff
    );
  }
  private async reconcileFailedDelivery(run: Run, op: Operation) {
    try {
      if (op.state === "creating" && !op.agentId) {
        const ids = await this.agents.find(run.id, op.id);
        if (ids.length > 1) {
          this.hold(run, "创建会话的结果不明确，已停止自动重发；请检查后选择重试");
          return false;
        }
        if (ids.length === 1) this.bindAgent(run, op, ids[0]);
      }
      if (op.agentId && op.agentId !== run.chat?.mainAgentId)
        await this.agents.inspect(op.agentId, op.id, op.createdAt);
      return true;
    } catch {
      this.hold(
        run,
        op.state === "creating" && !op.agentId
          ? "创建会话的结果不明确，已停止自动重发；请检查后选择重试"
          : "无法确认上一条指令是否送达，已停止自动重发；请检查后重试",
      );
      return false;
    }
  }
  private bindAgent(run: Run, op: Operation, agentId: string) {
    op.agentId = agentId;
    op.state = "ready";
    this.setSession(run, op, agentId);
  }
  private setSession(run: Run, op: Operation, agentId?: string) {
    const role = operationRole(run.settings, op.kind);
    if (role === "worker")
      run.tasks.find((candidateEntry) => candidateEntry.spec.id === op.taskId)!.agentId = agentId;
    else if (role === "reviewer") run.reviewerAgentId = agentId;
    else if (!run.chat || agentId === run.chat.mainAgentId) run.directorAgentId = agentId;
  }
  private async finishPlan(run: Run, value: unknown) {
    const plan = PlanSchema.parse(value);
    validatePlan(plan, run.settings);
    const changes = run.changeRequests?.at(-1);
    run.plan = plan;
    run.tasks = plan.tasks.map((spec) => {
      const profileId = profileForTask(run.settings, spec);
      const previous =
        changes && changes.planVersion === run.planVersion
          ? changes.previousTasks.find(
              (candidateEntry) =>
                candidateEntry.id === spec.id && candidateEntry.profileId === profileId,
            )
          : undefined;
      return { spec, profileId, status: "pending", reworks: 0, agentId: previous?.agentId };
    });
    run.phase = "executing";
    if (!run.planApproved) run.control = "paused";
    this.event(run, run.planApproved ? "总纲已保存，开始按依赖执行" : "总纲已生成，等待查看并批准");
  }
  private async validateApproval(
    run: Run,
    op: Operation,
    review: Review,
    evidence: Evidence,
    criteria: string[],
  ) {
    if (op.kind === "final" && (!run.tasks.length || !run.tasks.every(executionComplete)))
      throw new Error("仍有任务未执行完成，不能批准成果");
    if (run.settings.verificationCommands.length && !evidence.passed)
      throw new Error("用户指定的额外检查未通过，不能批准成果");
    if (
      criteria.some(
        (candidateConversation) =>
          !review.criteria.some(
            (r) => r.criterion === candidateConversation && r.passed && r.evidence.trim(),
          ),
      )
    )
      throw new Error("审核未覆盖全部原始验收标准");
  }
  private async finish(run: Run, op: Operation, value: unknown) {
    run.autoRetry = undefined;
    if (op.kind === "plan") {
      await this.finishPlan(run, value);
    } else if (op.kind === "execute") {
      const result = ResultSchema.parse(value),
        task = run.tasks.find((candidateEntry) => candidateEntry.spec.id === op.taskId)!;
      task.result = result;
      if (result.status === "blocked") {
        this.hold(run, `执行受阻：${result.summary}`);
        return;
      }
      if (run.executionAttempts) delete run.executionAttempts[task.profileId];
      run.executionRelay = undefined;
      task.status = "executed";
      run.phase = "executing";
      this.event(run, `执行完成：${task.spec.title}；全部任务完成后统一审核`);
    } else {
      const review = ReviewSchema.parse(value),
        task = run.tasks.find((candidateEntry) => candidateEntry.spec.id === op.taskId);
      const evidence = op.kind === "final" ? run.finalEvidence! : task!.evidence!;
      if (
        review.artifactId !== evidence.id ||
        (await this.repository.fingerprint(run)) !== evidence.id
      )
        throw new Error("审核版本与当前成果不一致，需重新验证后审核");
      const finalCriteria =
        op.reviewScope === "all_tasks" ? finalAcceptance(run.plan!) : run.plan!.acceptance;
      const criteria = op.kind === "final" ? finalCriteria : task!.spec.acceptance;
      if (review.decision === "approved") {
        await this.validateApproval(run, op, review, evidence, criteria);
      }
      if (task) task.review = review;
      else run.finalReview = review;
      if (review.decision === "blocked") {
        this.hold(run, `审核受阻：${review.summary}`);
        return;
      }
      if (review.decision === "changes_requested") this.rework(run, review);
      else if (task) {
        task.status = "approved";
        run.phase = "executing";
        this.event(run, `审核通过：${task.spec.title}`);
      } else {
        for (const approvedTask of run.tasks) approvedTask.status = "approved";
        run.phase = "awaiting_acceptance";
        run.control = "paused";
        this.event(
          run,
          `${operationLabel(run.settings, "final")}统一审核通过，等待你验收或提出修改意见`,
        );
      }
    }
    op.response = value;
    op.state = "done";
    op.completedAt = this.now();
    run.activeOperationId = undefined;
    this.save(run);
  }
  private rework(run: Run, review: Review) {
    const ids = new Set(review.findings.map((f) => f.taskId));
    for (const id of ids) {
      const task = run.tasks.find((candidateEntry) => candidateEntry.spec.id === id);
      if (!task) throw new Error(`审核引用未知任务：${id}`);
    }
    // Changing an accepted dependency invalidates all downstream acceptances.
    const invalid = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of run.tasks)
        if (!invalid.has(t.spec.id) && t.spec.dependsOn.some((d) => invalid.has(d))) {
          invalid.add(t.spec.id);
          changed = true;
        }
    }
    for (const task of run.tasks)
      if (invalid.has(task.spec.id)) {
        task.status = "pending";
        this.release(task.evidence);
        task.evidence = undefined;
        task.review = undefined;
        if (ids.has(task.spec.id)) {
          task.reworks++;
          task.feedback = JSON.stringify(review.findings.filter((f) => f.taskId === task.spec.id));
        } else task.feedback = "前置任务发生变更，请重新检查实现与集成兼容性";
      }
    // If a task review requests changes in a dependency, also reschedule the current task.
    const currentTask = run.tasks.find((candidateEntry) => candidateEntry.status === "reviewing");
    if (currentTask) {
      currentTask.status = "pending";
      this.release(currentTask.evidence);
      currentTask.evidence = undefined;
    }
    this.release(run.finalEvidence);
    run.finalEvidence = undefined;
    run.finalReview = undefined;
    run.phase = "executing";
    this.event(run, `需要返工：${[...ids].join("、")}`);
  }
  async submit(runId: string, actor: string, operationId: string, payload: unknown) {
    return this.locked(runId, async () => {
      const run = this.store.get(runId),
        op = this.current(run);
      const conversational = !!op && !!run.chat && op.agentId === run.chat.mainAgentId;
      if (
        !op ||
        op.id !== operationId ||
        !["running", "waiting_permission", "paused"].includes(run.control) ||
        !(conversational ? ["pending", "ready", "sending", "sent"] : ["sending", "sent"]).includes(
          op.state,
        )
      )
        throw new Error("提交对应的步骤已经结束");
      if (actor !== this.actor(run, op)) throw new Error("角色无权提交此步骤");
      const response = responseSchema(op.kind).parse(payload);
      const hash = createHash("sha256").update(JSON.stringify(response)).digest("hex");
      if (op.responseHash && op.responseHash !== hash) throw new Error("本轮已提交不同结果");
      if (!op.responseHash) {
        if (conversational) op.state = "sent";
        op.response = response;
        op.responseHash = hash;
        this.event(run, `已收到${this.describe(run, op).actor}提交的结果，等待本轮结束后校验`);
        this.save(run);
      }
      return { accepted: true };
    });
  }
  async markMigration(id: string, conversationId: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.chat || run.migrationConversationId === conversationId) return;
      run.migrationConversationId = conversationId;
      this.save(run);
    });
  }
  async attachConversation(id: string, conversationId: string, mainAgentId: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.chat) {
        if (run.chat.conversationId !== conversationId) throw new Error("任务已绑定其他主会话");
        return;
      }
      const old = run.directorAgentId;
      run.chat = { version: 1, conversationId, mainAgentId, legacyAgentId: old };
      run.directorAgentId = mainAgentId;
      // Already-created operations retain their agent and protocol. Only future
      // operations use the main chat; never resend an in-flight operation.
      const op = this.current(run);
      if (op?.kind === "plan" && op.state === "pending" && !op.agentId) op.agentId = mainAgentId;
      run.migrationConversationId = undefined;
      this.save(run);
    });
  }
  async recoverMain(id: string, agentId?: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (!run.chat) throw new Error("任务尚未迁入主对话");
      if (!agentId) run.chat.recovering = true;
      else {
        const old = run.chat.mainAgentId;
        const op = this.current(run);
        if (op?.agentId === old) {
          op.state = "abandoned";
          run.activeOperationId = undefined;
        }
        run.chat.mainAgentId = agentId;
        run.chat.recovering = false;
        run.directorAgentId = agentId;
      }
      this.save(run);
    });
  }
  async dispatch(id: string, taskId: string) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.control !== "running" || !["planning", "executing"].includes(run.phase))
        throw new Error("当前状态不能派发新任务");
      const draft = run.plan ?? PlanSchema.parse(this.current(run)?.response);
      validatePlan(draft, run.settings);
      const spec = draft.tasks.find((candidateEntry) => candidateEntry.id === taskId);
      if (!spec) throw new Error("任务不在已提交的总纲中");
      const task = run.tasks.find((candidateEntry) => candidateEntry.spec.id === taskId);
      if (task && task.status !== "pending") throw new Error("任务已派发或已通过");
      run.dispatchOrder = [...new Set([...(run.dispatchOrder ?? []), taskId])];
      this.save(run);
      return {
        taskId,
        executorId: profileForTask(run.settings, spec),
        queued: true,
        note: "当前轮结束且前置任务执行完成后串行执行，全部完成后统一审核",
      };
    });
  }
  private async requestChanges(run: Run, input: FinalControl) {
    const feedback = input.feedback?.trim();
    if (!feedback || feedback.length > 16000) throw new Error("请填写修改意见（最多 16000 字）");
    if (
      this.store
        .unfinishedWorkspaceRuns()
        .some(
          (r) =>
            r.id !== run.id &&
            (r.cwd === run.cwd || (!!run.workspaceId && r.workspaceId === run.workspaceId)),
        )
    )
      throw new Error("当前目录已有其他未结束的任务，请先完成或取消该任务");
    await this.repository.assertBranch(run);
    run.planVersion = (run.planVersion ?? 1) + 1;
    run.changeRequests = [
      ...(run.changeRequests ?? []),
      {
        requestedAt: this.now(),
        feedback,
        planVersion: run.planVersion,
        artifactId: run.finalEvidence!.id,
        previousPlan: run.plan!,
        previousReview: run.finalReview!,
        previousAcceptance: run.userAcceptance,
        previousTasks: run.tasks.map((candidateEntry) => ({
          id: candidateEntry.spec.id,
          profileId: candidateEntry.profileId,
          agentId: candidateEntry.agentId,
          result: candidateEntry.result,
        })),
      },
    ];
    run.roundStartedAt = this.now();
    this.renewBudget(run);
    run.roundOperationOffset = run.operations.length;
    this.release(run.finalEvidence, ...run.tasks.map((candidateEntry) => candidateEntry.evidence));
    const executionAgentId = run.tasks[0]?.agentId;
    run.plan = undefined;
    run.tasks = [];
    run.finalEvidence = undefined;
    run.finalReview = undefined;
    run.userAcceptance = undefined;
    run.delivery = undefined;
    run.dispatchOrder = [];
    run.planApproved = !requiresPlanApproval(run);
    run.planApprovedAt = undefined;
    run.phase = "planning";
    run.control = "running";
    if (collaborationMode(run) === "execute_review") {
      this.initializeDirectExecution(run, executionAgentId);
      return;
    }
    this.event(
      run,
      `修改意见已提交，${operationLabel(run.settings, "plan")}将安排修改；保留原目标和现有文件`,
    );
  }
  private async finalControl(
    run: Run,
    action: ControlAction,
    input: FinalControl,
    receipt?: string,
  ) {
    if (
      !hasFinalResult(run) ||
      !run.plan ||
      !run.tasks.length ||
      !run.tasks.every(executionComplete)
    )
      throw new Error("当前没有可验收的最终成果");
    if (
      input.expectedRevision !== run.revision ||
      input.artifactId !== run.finalEvidence!.id ||
      run.finalReview!.artifactId !== run.finalEvidence!.id
    )
      throw new Error("任务或审核版本已变化，请刷新后重试");
    if (action !== "request_changes" && run.userAcceptance)
      throw new Error("该成果已经验收，请刷新查看");
    if (action === "reject_final") {
      run.userAcceptance = {
        decision: "rejected",
        artifactId: run.finalEvidence!.id,
        decidedAt: this.now(),
      };
      run.control = "canceled";
      this.event(run, "你选择不采纳并结束任务；文件和分支已保留");
    } else if (action === "accept_final") {
      await this.repository.assertBranch(run);
      if ((await this.repository.fingerprint(run)) !== run.finalEvidence!.id)
        throw new Error("代码已在最终审核后发生变化，请提交修改意见，让团队重新审核当前成果");
      run.userAcceptance = {
        decision: "approved",
        artifactId: run.finalEvidence!.id,
        decidedAt: this.now(),
      };
      run.phase = "completed";
      run.control = "running";
      this.event(run, "你已验收通过，任务完成；文件和分支已保留");
    } else {
      await this.requestChanges(run, input);
    }
    if (receipt) (run.chatReceipts ??= {})[receipt] = action;
    this.save(run);
    return { ok: true };
  }

  async mergeAccepted(id: string, targetBranch?: string) {
    return this.locked("create", () =>
      this.locked(id, async () => {
        const run = this.store.get(id);
        if (
          run.phase !== "completed" ||
          run.userAcceptance?.decision !== "approved" ||
          run.activeOperationId
        )
          throw new Error("请先验收当前成果，再合并");
        if (run.control !== "running") throw new Error("交付已暂停或取消，不能继续合并");
        if (run.delivery?.status === "merged") return run.delivery;
        if (targetBranch && run.sourceBranch && targetBranch !== run.sourceBranch)
          throw new Error(`此任务的原分支是 ${run.sourceBranch}，不能更换交付目标`);
        run.sourceBranch ??= targetBranch;
        if (!run.sourceBranch)
          throw new Error("此任务未记录原分支，请单独回复“合并成果到 <目标分支>”后再交付");
        if (
          this.store
            .unfinishedWorkspaceRuns()
            .some(
              (other) => other.id !== id && (other.cwd === run.cwd || other.cwd === run.repository),
            )
        )
          throw new Error("成果或目标工作区已有其他未结束的协作任务，请先完成或取消该任务");
        run.delivery = { status: "merging" };
        this.event(run, `正在提交验收成果并合并到 ${run.sourceBranch}`);
        this.save(run);
        try {
          run.delivery = await this.repository.mergeAccepted(run);
          this.event(run, `验收成果已提交并合并到 ${run.delivery.targetBranch}；未推送远端`);
          this.save(run);
          return run.delivery;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          run.delivery = { status: "failed", error: message };
          this.event(run, `成果合并失败：${message}；成果已保留，可重试合并`);
          this.save(run);
          throw error;
        }
      }),
    );
  }

  private mergeRecoveryRun(id: string) {
    const run = this.store.get(id);
    if (
      run.phase !== "completed" ||
      run.control !== "running" ||
      run.userAcceptance?.decision !== "approved" ||
      run.delivery?.status !== "failed" ||
      !run.finalEvidence ||
      run.activeOperationId
    )
      throw new Error("只有已验收且合并失败的成果允许主 Agent 处理合并问题");
    if (
      this.store
        .unfinishedWorkspaceRuns()
        .some((other) => other.id !== id && (other.cwd === run.cwd || other.cwd === run.repository))
    )
      throw new Error("成果或目标工作区已有其他未结束的协作任务");
    return { run, failure: run.delivery, evidence: run.finalEvidence };
  }

  async prepareMergeRecovery(id: string, sourceMessageId: string) {
    return this.locked("create", () =>
      this.locked(id, async () => {
        const { run, failure } = this.mergeRecoveryRun(id);
        const context = await this.repository.mergeRecoveryContext(run);
        failure.recovery = { sourceMessageId };
        this.event(run, `主 Agent 正在处理合并到 ${context.targetBranch} 的问题；成果已保留`);
        this.save(run);
        return context;
      }),
    );
  }

  async finishMergeRecovery(id: string, input: { sourceMessageId: string; summary: string }) {
    const result = await this.locked("create", () =>
      this.locked(id, async () => {
        const { run, failure, evidence } = this.mergeRecoveryRun(id);
        if (failure.recovery?.sourceMessageId !== input.sourceMessageId)
          throw new Error("请先获取当前合并修复上下文");
        const context = await this.repository.mergeRecoveryContext(run);
        if (context.unmergedFiles.length)
          throw new Error(`仍有未解决的冲突：${context.unmergedFiles.join("、")}`);
        if (context.currentBranch !== run.branch)
          throw new Error(`请先切回成果分支 ${run.branch} 再提交合并修复`);
        await this.repository.assertBranch(run);
        const unchanged = (await this.repository.fingerprint(run)) === evidence.id;
        if (unchanged) return { status: "retry" as const };
        await this.finalControl(run, "request_changes", {
          artifactId: evidence.id,
          expectedRevision: run.revision,
          feedback: `The main Agent repaired the merge: ${input.summary}. Verify and review the conflict resolution on the current result; do not reimplement completed changes.`,
        });
        return { status: "review_required" as const, runId: run.id };
      }),
    );
    if (result.status === "review_required") return result;
    return this.mergeAccepted(id);
  }

  private async recoverResult(run: Run, op: Operation) {
    let outputError: string | undefined;
    const state = await this.agents.inspect(op.agentId!, op.id, op.createdAt);
    if (!sessionSettled(state)) throw new Error("原 AI 仍在执行或等待权限，请先在 Paseo 中处理");
    // Recover valid completed work after an adapter fix, without another
    // AI turn. Interrupted or blocked work still takes the retry path. A final
    // review is only recovered once it was submitted, so it can be rechecked
    // against the same artifact.
    if (
      state.status === "idle" &&
      state.seen &&
      !state.interrupted &&
      ["sent", "sending"].includes(op.state) &&
      (["plan", "execute"].includes(op.kind) || (op.kind === "final" && !!op.response))
    ) {
      let response: unknown;
      try {
        const candidate = responseSchema(op.kind).parse(op.response ?? parseOutput(state.output));
        if (op.kind === "plan") validatePlan(PlanSchema.parse(candidate), run.settings);
        response = candidate;
      } catch (error) {
        outputError = String(error).slice(0, 2000);
      }
      if (
        response &&
        (op.kind !== "execute" || ResultSchema.parse(response).status === "ready_for_review")
      ) {
        run.control = "running";
        await this.finish(run, op, response);
        return { recovered: true, outputError };
      }
    }
    if (state.status === "missing" || state.status === "error") {
      if (!sessionSettled(state)) throw new Error("原 AI 仍在执行或等待权限，请先在 Paseo 中处理");
      if (op.agentId === run.chat?.mainAgentId)
        throw new Error("主会话不可用，请先在 Paseo 中恢复原主对话，再重试当前步骤");
      // Retain the failed operation, but create the retry session from
      // the saved profile instead of reusing an unusable agent.
      this.setSession(run, op);
    }
    return { recovered: false, outputError };
  }
  private failureText(evidence: { message: string; code?: string; diagnostic?: string }) {
    return [evidence.message, evidence.code, evidence.diagnostic]
      .filter((part) => part && part.trim())
      .join("\n")
      .slice(0, 4000);
  }
  private async tryFinishValidExecution(run: Run, op: Operation, state?: AgentSnapshot) {
    if (op.kind !== "execute") return false;
    // lifecycle=error can still own a live turn. Do not start the next phase until it stops.
    if (state && !sessionSettled(state)) return false;
    let response: unknown = op.response;
    if (response === undefined && state?.output.trim()) {
      try {
        response = parseOutput(state.output);
      } catch {
        return false;
      }
    }
    const parsed = ResultSchema.safeParse(response);
    if (!parsed.success) return false;
    run.control = "running";
    await this.finish(run, op, parsed.data);
    return true;
  }
  /** Classify a real provider failure. Quota on an execute turn can hand off; other classes do not. */
  private async handleTerminalFailure(run: Run, op: Operation, state: AgentSnapshot) {
    if (await this.tryFinishValidExecution(run, op, state)) return true;
    const evidence = providerFailureEvidence(state);
    if (!evidence) {
      if (state.status !== "error") return false;
      throw new Error(state.error?.trim() || "AI 会话不可用");
    }
    const text = this.failureText(evidence);
    const failure = classifyProviderFailure({
      message: evidence.message,
      code: evidence.code,
      diagnostic: evidence.diagnostic,
      source: "provider",
    });
    if (failure.class === "network") throw new Error(text.slice(0, 2000) || "AI 会话不可用");
    if (
      failure.handoff &&
      op.kind === "execute" &&
      !["paused", "canceled", "canceling"].includes(run.control)
    ) {
      await this.beginHandoff(run, op, text);
      return true;
    }
    throw new Error(text.slice(0, 2000) || "AI 会话不可用");
  }
  private async selectFallback(run: Run, profileId: string, attempted: ExecutionModel[]) {
    const unavailable: string[] = [];
    for (const model of run.settings.executionFallbacks?.[profileId] ?? []) {
      if (attempted.some((item) => item.provider === model.provider)) continue;
      try {
        await this.agents.validateExecutionModel(model);
      } catch (error) {
        unavailable.push(
          `${model.provider}（${error instanceof Error ? error.message : String(error)}）`,
        );
        continue;
      }
      return { model, unavailable };
    }
    return { unavailable };
  }
  private quotaMessage(run: Run, profileId: string, text: string, unavailable: string[]) {
    const list = run.settings.executionFallbacks?.[profileId] ?? [];
    const attempted = run.executionAttempts?.[profileId] ?? [];
    const exhausted =
      list.length > 0 &&
      list.every((model) => attempted.some((item) => item.provider === model.provider));
    if (exhausted) return `备用模型额度也已耗尽，进度已保留，请手动处理。${text.slice(0, 800)}`;
    if (unavailable.length)
      return `备用模型不可用，进度已保留：${unavailable.join("、")}。${text.slice(0, 800)}`;
    return `模型额度已耗尽，进度已保留，可以换模型继续。${text.slice(0, 800)}`;
  }
  private async beginHandoff(run: Run, op: Operation, text: string) {
    try {
      if (["paused", "canceled", "canceling"].includes(run.control)) return;
      if (op.kind !== "execute" || !op.taskId) {
        this.hold(run, text.slice(0, 2000));
        return;
      }
      const current = op.executionModel ?? this.profileExecutionModel(run, op.profileId);
      const attempted = rememberAttempt(run.executionAttempts?.[op.profileId] ?? [], current);
      run.executionAttempts = { ...run.executionAttempts, [op.profileId]: attempted };
      const { model, unavailable } = await this.selectFallback(run, op.profileId, attempted);
      const token = (run.relayToken ?? run.revision) + 1;
      run.relayToken = token;
      const base = {
        source: "none" as const,
        operationId: op.id,
        taskId: op.taskId,
        profileId: op.profileId,
        agentId: op.agentId,
        errorClass: "quota" as const,
        message: text.slice(0, 1500),
        attempted,
        manual: true,
        token,
        at: this.now(),
      };
      if (!model) {
        run.executionRelay = { ...base, status: "blocked" };
        this.hold(run, this.quotaMessage(run, op.profileId, text, unavailable));
        return;
      }
      run.executionRelay = { ...base, status: "stopping", source: "automatic", target: model };
      this.event(run, `模型额度已耗尽，正在切换到 ${model.provider}`);
      this.save(run);
      await this.continueRelay(run);
    } catch (error) {
      if (["canceled", "canceling"].includes(run.control)) return;
      this.hold(
        run,
        `模型接力失败，进度已保留：${String(error instanceof Error ? error.message : error).slice(0, 1500)}`,
      );
    }
  }
  private failRelay(relay: ExecutionRelay, reason: string): ExecutionRelay {
    return {
      source: relay.source,
      operationId: relay.operationId,
      taskId: relay.taskId,
      profileId: relay.profileId,
      agentId: relay.agentId,
      errorClass: relay.errorClass,
      message: relay.message,
      attempted: relay.attempted,
      manual: relay.manual,
      token: relay.token,
      at: relay.at,
      requestId: relay.requestId,
      status: "failed",
      reason,
      ...("target" in relay ? { target: relay.target } : {}),
    };
  }
  private async confirmStopped(run: Run, op: Operation) {
    if (!op.agentId || op.agentId === run.chat?.mainAgentId) return true;
    try {
      await this.agents.stop(op.agentId);
    } catch {
      return false;
    }
    let state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
    if (sessionSettled(state)) return true;
    try {
      await this.agents.stop(op.agentId);
    } catch {
      return false;
    }
    state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
    return sessionSettled(state);
  }
  private async collectHandoff(run: Run, op: Operation) {
    let activity: string | undefined;
    let activityMissing = !op.agentId;
    let activityTruncated = false;
    if (op.agentId) {
      try {
        const evidence = await this.agents.handoffActivity(op.agentId, op.id);
        activity = evidence.text;
        activityMissing = evidence.missing;
        activityTruncated = evidence.truncated;
      } catch {
        activityMissing = true;
      }
    }
    let paths: string[] | undefined;
    let diff: string | undefined;
    let changesMissing = false;
    let changesTruncated = false;
    let pathCount: number | undefined;
    try {
      const changes = await this.repository.workingChanges(run);
      paths = changes.paths;
      diff = changes.diff;
      changesMissing = changes.missing === true;
      changesTruncated = changes.truncated === true;
      pathCount = changes.pathCount;
    } catch {
      changesMissing = true;
    }
    return renderHandoffPackage({
      activity,
      activityMissing,
      activityTruncated,
      paths,
      pathCount,
      diff,
      changesMissing,
      changesTruncated,
    });
  }
  /** After the old turn has stopped, keep a valid result instead of starting another model. */
  private async recoverFinishedExecution(run: Run, op: Operation) {
    if (op.agentId && op.agentId !== run.chat?.mainAgentId) {
      const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
      if (!sessionSettled(state)) {
        const relay = run.executionRelay;
        if (relay && (relay.status === "stopping" || relay.status === "preparing")) {
          run.executionRelay = this.failRelay(relay, "停止旧执行会话失败或仍在运行");
          this.hold(run, "旧执行会话未能停止，未启动新模型；进度已保留，可稍后重试切换");
        }
        return true;
      }
      if (!(await this.tryFinishValidExecution(run, op, state))) return false;
    } else if (!(await this.tryFinishValidExecution(run, op))) return false;
    if (run.executionRelay) {
      run.executionRelay = undefined;
      this.save(run);
    }
    return true;
  }
  private async continueRelay(run: Run) {
    const relay = run.executionRelay;
    if (!relay || (relay.status !== "stopping" && relay.status !== "preparing")) return;
    if (["paused", "canceled", "canceling"].includes(run.control)) return;
    const op = run.operations.find((candidate) => candidate.id === relay.operationId);
    if (!op) {
      this.hold(run, "接力来源操作不存在，进度已保留");
      return;
    }
    if (run.activeOperationId && run.activeOperationId !== op.id) {
      run.executionRelay = undefined;
      this.save(run);
      return;
    }
    if (this.budgetExhausted(run)) {
      run.executionRelay = this.failRelay(relay, "时间预算已耗尽");
      this.hold(run, "本轮任务总时间预算已耗尽，接力已停止；进度已保留");
      return;
    }
    let preparing: Extract<ExecutionRelay, { status: "preparing" }>;
    if (relay.status === "stopping") {
      const stopped = await this.confirmStopped(run, op);
      const latest = this.store.get(run.id);
      if (["paused", "canceled", "canceling"].includes(latest.control)) {
        run.control = latest.control;
        return;
      }
      if (!stopped) {
        run.executionRelay = this.failRelay(relay, "停止旧执行会话失败或仍在运行");
        this.hold(run, "旧执行会话未能停止，未启动新模型；进度已保留，可稍后重试切换");
        return;
      }
      if (await this.recoverFinishedExecution(run, op)) return;
      const handoff = await this.collectHandoff(run, op);
      preparing = { ...relay, status: "preparing", handoff, at: this.now() };
      run.executionRelay = preparing;
      this.save(run);
    } else preparing = relay;
    if (["paused", "canceled", "canceling"].includes(run.control)) return;
    op.state = "abandoned";
    op.superseded = true;
    op.handoff = {
      at: this.now(),
      source: preparing.source === "manual" ? "manual" : "automatic",
      errorClass: "quota",
      target: preparing.target,
      fromModel: op.executionModel,
    };
    run.executionModels = { ...run.executionModels, [op.profileId]: preparing.target };
    run.executionRelay = undefined;
    const task = run.tasks.find((candidate) => candidate.spec.id === op.taskId);
    if (task?.agentId && task.agentId === op.agentId) task.agentId = undefined;
    this.enqueue(run, "execute", op.taskId, 0, preparing.handoff);
    this.event(run, `已切换执行模型到 ${preparing.target.provider}，继续同一任务`);
    this.save(run);
  }
  private relayFingerprint(model: ExecutionModel) {
    return JSON.stringify({
      provider: model.provider,
      thinkingOptionId: model.thinkingOptionId ?? null,
      featureValues: model.featureValues ?? null,
    });
  }
  async switchExecutor(
    id: string,
    input: {
      expectedOperationId: string;
      token: number;
      requestId: string;
      model: ExecutionModel;
    },
  ) {
    return this.locked(id, async () => {
      const run = this.store.get(id);
      if (run.control === "canceled" || run.phase === "completed") throw new Error("任务已结束");
      if (run.phase === "awaiting_acceptance") throw new Error("请验收成果或提交修改意见");
      const fingerprint = this.relayFingerprint(input.model);
      return (
        (await this.resumeSwitch(run, input, fingerprint)) ??
        this.beginManualSwitch(run, input, fingerprint)
      );
    });
  }
  private async resumeSwitch(
    run: Run,
    input: {
      expectedOperationId: string;
      token: number;
      requestId: string;
      model: ExecutionModel;
    },
    fingerprint: string,
  ) {
    const receipt = run.relayReceipts?.[input.requestId];
    if (receipt && receipt.fingerprint !== fingerprint)
      throw new Error("重复的切换请求与上次目标不一致");
    // A finished switch is only a receipt. Repeating it must not dispatch again.
    if (receipt?.operationId) return { ok: true as const, operationId: receipt.operationId };
    const relay = run.executionRelay;
    if (
      receipt &&
      relay?.requestId === input.requestId &&
      (relay.status === "stopping" || relay.status === "preparing")
    )
      return { ok: true as const, operationId: run.activeOperationId };
    if (receipt && relay?.requestId === input.requestId && relay.status === "failed")
      return this.retryFailedSwitch(run, input, relay, receipt);
    return undefined;
  }
  private async retryFailedSwitch(
    run: Run,
    input: {
      expectedOperationId: string;
      token: number;
      requestId: string;
      model: ExecutionModel;
    },
    relay: Extract<ExecutionRelay, { status: "failed" }>,
    receipt: { provider: string; fingerprint: string; operationId?: string },
  ) {
    if (relay.token !== input.token || relay.operationId !== input.expectedOperationId)
      throw new Error("切换请求已过期，请刷新后重试");
    const op = this.current(run);
    if (!op || op.kind !== "execute" || op.id !== relay.operationId)
      throw new Error("切换请求已过期，请刷新后重试");
    // Pause and cancellation stay as the user left them. Resume is a separate control.
    if (run.control !== "needs_attention" && run.control !== "running")
      throw new Error("当前步骤不能换模型继续");
    const sourceId = op.id;
    run.control = "running";
    this.renewBudget(run);
    run.executionRelay = {
      ...relay,
      status: "stopping",
      source: "manual",
      target: input.model,
    };
    this.save(run);
    await this.continueRelay(run);
    const latest = this.store.get(run.id);
    if (latest.executionRelay?.status === "failed") throw new Error(latest.message);
    const next = this.current(latest);
    if (next && next.id !== sourceId) {
      latest.relayReceipts = {
        ...latest.relayReceipts,
        [input.requestId]: { ...receipt, operationId: next.id },
      };
      this.save(latest);
    }
    return { ok: true as const, operationId: next?.id };
  }
  private async beginManualSwitch(
    run: Run,
    input: {
      expectedOperationId: string;
      token: number;
      requestId: string;
      model: ExecutionModel;
    },
    fingerprint: string,
  ) {
    const relay = run.executionRelay;
    const op = this.current(run);
    if (
      !relay ||
      !relay.manual ||
      relay.errorClass !== "quota" ||
      !["blocked", "failed"].includes(relay.status)
    )
      throw new Error("当前步骤不能换模型继续");
    if (run.control !== "needs_attention") throw new Error("当前步骤不能换模型继续");
    if (!op || op.kind !== "execute" || op.id !== input.expectedOperationId)
      throw new Error("只有额度耗尽的执行步骤可以换模型");
    if (relay.operationId !== input.expectedOperationId || relay.token !== input.token)
      throw new Error("切换请求已过期，请刷新后重试");
    await this.agents.validateExecutionModel(input.model);
    run.relayReceipts = {
      ...run.relayReceipts,
      [input.requestId]: { provider: input.model.provider, fingerprint },
    };
    run.control = "running";
    this.renewBudget(run);
    run.executionRelay = {
      ...relay,
      status: "stopping",
      source: "manual",
      target: input.model,
      requestId: input.requestId,
      at: this.now(),
    };
    this.event(run, `正在切换执行模型到 ${input.model.provider}`);
    this.save(run);
    await this.continueRelay(run);
    const latest = this.store.get(run.id);
    if (latest.executionRelay?.status === "failed") throw new Error(latest.message);
    const next = this.current(latest);
    if (next && next.id !== op.id) {
      latest.relayReceipts = {
        ...latest.relayReceipts,
        [input.requestId]: {
          provider: input.model.provider,
          fingerprint,
          operationId: next.id,
        },
      };
      this.save(latest);
    }
    return { ok: true as const, operationId: next?.id };
  }
  private async retryRun(run: Run) {
    if (run.control !== "needs_attention") throw new Error("仅受阻任务可以重试");
    const op = this.current(run);
    if (op?.agentId && op.agentId !== run.chat?.mainAgentId) {
      const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
      // Leave the relay untouched until the old turn is confirmed stopped.
      if (!sessionSettled(state)) throw new Error("原 AI 仍在执行或等待权限，请先在 Paseo 中处理");
    }
    // A manual retry starts a fresh automatic retry budget and keeps the current model.
    run.autoRetry = undefined;
    run.executionRelay = undefined;
    this.renewBudget(run);
    return this.retryCurrent(run, "用户检查后重试当前步骤");
  }
  private async retryCurrent(run: Run, message: string) {
    await this.repository.assertBranch(run);
    const op = this.current(run);
    let outputError: string | undefined;
    if (op?.state === "creating" && !op.agentId) {
      const ids = await this.agents.find(run.id, op.id);
      if (ids.length > 1) throw new Error("发现多个可能的执行会话，请先在 Paseo 中核对");
      if (ids.length === 1) this.bindAgent(run, op, ids[0]);
    }
    if (op?.agentId) {
      const result = await this.recoverResult(run, op);
      if (result.recovered) return true;
      outputError = result.outputError;
    }
    run.control = "running";
    if (op) {
      op.state = "abandoned";
      run.activeOperationId = undefined;
      if (op.kind === "review" || op.kind === "final") {
        run.phase = op.kind === "review" ? "reviewing" : "final_review";
      } else {
        this.enqueue(run, op.kind, op.taskId, op.formatRetries);
        if (outputError)
          this.current(run)!.prompt +=
            `\nThe previous result was invalid. Correct it and resubmit without repeating completed changes. Error: ${outputError}`;
      }
    }
    this.event(run, message);

    return false;
  }

  private async reviseRun(run: Run, goal: string | undefined) {
    if (!["paused", "needs_attention"].includes(run.control))
      throw new Error("请先暂停任务，再修改要求");
    if (!goal?.trim()) throw new Error("新目标不能为空");
    const op = this.current(run);
    if (op?.state === "creating" && !op.agentId)
      throw new Error("请先检查创建中的会话并重试，再修改需求");
    if (op?.agentId && op.agentId !== run.chat?.mainAgentId) {
      await this.agents.stop(op.agentId);
      const state = await this.agents.inspect(op.agentId, op.id, op.createdAt);
      if (["running", "permission"].includes(state.status))
        throw new Error("正在停止原 AI，请稍后保存新要求");
    }
    if (op) op.state = "abandoned";
    run.activeOperationId = undefined;
    run.goal = goal.trim();
    run.executionRelay = undefined;
    run.executionAttempts = undefined;
    run.planVersion = (run.planVersion ?? 1) + 1;
    this.release(run.finalEvidence, ...run.tasks.map((candidateEntry) => candidateEntry.evidence));
    const executionAgentId = run.tasks[0]?.agentId;
    run.plan = undefined;
    run.tasks = [];
    run.finalEvidence = undefined;
    run.finalReview = undefined;
    run.dispatchOrder = [];
    run.planApproved = !requiresPlanApproval(run);
    run.planApprovedAt = undefined;
    run.phase = "planning";
    run.control = "running";
    this.renewBudget(run);
    if (collaborationMode(run) === "execute_review") {
      this.initializeDirectExecution(run, executionAgentId);
      return;
    }
    this.event(run, `需求已更新为第 ${run.planVersion} 版，保留现有代码，重新设计并验收`);
  }
  private addNote(run: Run, text: string | undefined) {
    if (!text?.trim()) throw new Error("补充要求不能为空");
    run.notes = [...(run.notes ?? []), { text: text.trim(), at: this.now() }];
    this.event(run, "已记录补充要求，后续步骤的 AI 会一并遵循");
  }
  private async approvePlan(run: Run) {
    if (!run.plan || run.planApproved) throw new Error("没有待批准的总纲");
    run.planApproved = true;
    run.planApprovedAt = this.now();
    run.control = "running";
    this.renewBudget(run);
    this.event(run, "总纲已批准");
  }
  private assertControlState(run: Run, action: ControlAction) {
    const recoveringMerge = run.delivery?.status === "failed";
    const recoveryControl =
      recoveringMerge && ["pause", "resume", "cancel", "note"].includes(action);
    if ((run.phase === "completed" && !recoveryControl) || run.control === "canceled")
      throw new Error("任务已结束");
    if (run.phase === "awaiting_acceptance" && action !== "cancel")
      throw new Error("请验收成果或提交修改意见");
    if (run.control === "canceling" && action === "note")
      throw new Error("正在停止 AI，请等待停止后再补充要求");
    return recoveringMerge;
  }
  async control(
    id: string,
    action: ControlAction,
    goal?: string,
    final: FinalControl = {},
    receipt?: string,
  ) {
    if (action === "cancel" || action === "revise") this.checks.get(id)?.abort();
    let canceled: Run | undefined;
    const apply = () =>
      this.locked(id, async () => {
        const run = this.store.get(id);
        if (receipt && run.chatReceipts?.[receipt] === action) return { ok: true };
        if (["accept_final", "reject_final", "request_changes"].includes(action))
          return this.finalControl(run, action, final, receipt);
        const recoveringMerge = this.assertControlState(run, action);
        if (action === "pause") {
          run.control = "paused";
          this.event(run, "已暂停后续派发；当前 AI 可完成本轮");
        }
        if (action === "cancel") {
          run.control = "canceled";
          this.event(run, "已取消；工作区与成果已保留");
          canceled = run;
        }
        if (action === "approve_plan") {
          await this.approvePlan(run);
        }
        if (action === "resume") {
          if (!run.planApproved && run.plan) throw new Error("请先批准总纲");
          if (!recoveringMerge && !canResumeRun(run))
            throw new Error("请使用检查后重试，避免重复发送未确认的指令");
          run.control = "running";
          this.renewBudget(run);
          this.event(run, "继续执行");
        }
        if (action === "retry") {
          if (await this.retryRun(run)) return { ok: true };
        }
        if (action === "revise") await this.reviseRun(run, goal);
        if (action === "note") this.addNote(run, final.feedback);
        this.save(run);
        return { ok: true };
      });
    // Reopening an old result must not race with creation in the same checkout.
    const outcome = await (action === "request_changes" ? this.locked("create", apply) : apply());
    if (canceled) await this.interruptCanceled(canceled);
    return outcome;
  }
}
