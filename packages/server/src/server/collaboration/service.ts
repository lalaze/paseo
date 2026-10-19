import { migrateNativeCollaboration } from "./migration.js";
import { muteCollaborationNotification } from "./notifications.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SwitchExecutionModelToolSchema,
  SwitchExecutorInputSchema,
  type CollaborationCommand,
  type CollaborationState,
} from "@getpaseo/protocol/collaboration/rpc";
import {
  PlanSchema,
  ResultSchema,
  ReviewSchema,
  SettingsSchema,
  RolePromptsSchema,
  CollaborationIsolationSchema,
  CollaborationModeSchema,
  collaborationMode,
  REVIEWER_ACTOR,
  operationRole,
  summarize,
} from "@getpaseo/protocol/collaboration/schema";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { Conversations } from "./conversations.js";
import { GitRepository } from "./repository.js";
import { CollaborationGateway, type CollaborationHost } from "./gateway.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { ImportedTimelineEntry } from "../agent/agent-sdk-types.js";
import { StatusOptionsSchema, runStatus, statusDetails } from "./model-context.js";

const openSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().optional(),
  goal: z.string().max(32000).optional(),
  fresh: z.boolean().optional(),
  mode: CollaborationModeSchema.optional(),
  isolation: CollaborationIsolationSchema.optional(),
  settings: SettingsSchema.optional(),
});
const controlSchema = z.object({
  sourceMessageId: z.string(),
  action: z.enum([
    "pause",
    "resume",
    "cancel",
    "retry",
    "revise",
    "approve_plan",
    "accept_final",
    "reject_final",
    "request_changes",
    "note",
  ]),
  confirmationKey: z.string().optional(),
  goal: z.string().trim().min(1).max(32000).optional(),
  feedback: z.string().trim().min(1).max(16000).optional(),
});

export class CollaborationService {
  private runtime: { store: Store; engine: Engine; conversations: Conversations } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;
  readonly root: string;
  constructor(
    private host: CollaborationHost,
    home: string,
    private legacyEnabled: () => boolean,
  ) {
    this.root = process.env.PASEO_DIRECTOR_DATA_DIR ?? join(home, "director");
  }
  isActive() {
    return this.runtime !== null;
  }
  timelineNotices(agentId: string): ImportedTimelineEntry[] {
    const conversations = this.runtime?.store.conversations() ?? [];
    return conversations
      .filter((conversation) => conversation.agentId === agentId)
      .flatMap((conversation) =>
        conversation.notices
          .filter((notice) => notice.delivery === "timeline" && notice.state !== "pending")
          .map(
            (notice): ImportedTimelineEntry => ({
              item: { type: "user_message", clientMessageId: notice.id, text: notice.text },
              timestamp:
                notice.createdAt === undefined
                  ? undefined
                  : new Date(notice.createdAt).toISOString(),
            }),
          ),
      );
  }
  start() {
    if (this.closed) throw new Error("协作服务已关闭");
    if (this.legacyEnabled())
      throw new Error("请先在插件设置停用 paseo-director，再启用内置协作。原任务和配置会保留。");
    if (this.runtime) return this.runtime;
    const store = new Store(join(this.root, "director.sqlite"));
    try {
      migrateNativeCollaboration(store);
    } catch (error) {
      store.close();
      throw error;
    }
    const gateway = new CollaborationGateway(this.host, store.meta<number>("mcpPort"));
    const engine = new Engine(
      store,
      gateway,
      new GitRepository(
        this.root,
        this.host.createIsolatedWorkspace,
        this.host.findIsolatedWorkspace,
        this.host.discardIsolatedWorkspace,
      ),
    );
    const conversations = new Conversations(store, engine, gateway);
    this.runtime = { store, engine, conversations };
    this.unsubscribe = this.host.agentManager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          ["turn_started", "turn_completed", "turn_failed", "turn_canceled"].includes(
            event.event.type,
          )
        ) {
          const stream = event.event;
          if (
            stream.type === "turn_started" ||
            stream.type === "turn_completed" ||
            stream.type === "turn_failed" ||
            stream.type === "turn_canceled"
          )
            void engine
              .recordUsage(event.agentId, stream)
              .catch((error) =>
                this.host.logger.error({ err: error }, "Collaboration usage recording failed"),
              );
        }
        if (
          event.type === "agent_state" ||
          (event.type === "agent_stream" &&
            ["turn_completed", "turn_failed", "turn_canceled", "permission_resolved"].includes(
              event.event.type,
            ))
        )
          this.wake();
      },
      { replayState: false },
    );
    // Events drive normal progress; this timer also checks deadlines and recovers missed events.
    this.timer = setInterval(() => this.wake(), 2500);
    this.timer.unref();
    this.wake();
    return this.runtime;
  }
  restore() {
    if (existsSync(join(this.root, "director.sqlite")) && !this.legacyEnabled()) {
      try {
        this.start();
      } catch (error) {
        this.host.logger.error({ err: error }, "Collaboration recovery failed");
      }
    }
  }
  private wake() {
    if (this.closed || this.pumping || !this.runtime) return;
    const runtime = this.runtime;
    this.pumping = (async () => {
      await runtime.conversations.migrate();
      await runtime.conversations.tick();
      await runtime.engine.tick();
    })()
      .catch((error) => this.host.logger.error({ err: error }, "Collaboration progress failed"))
      .finally(() => {
        this.pumping = null;
      });
  }
  status(): CollaborationState {
    try {
      const { store, conversations } = this.start();
      return {
        settings: store.settings() ?? null,
        rolePrompts: store.rolePrompts(),
        error: null,
        conversations: store.conversations().map((candidateConversation) => {
          const summary = conversations.summary(candidateConversation.id);
          return Object.assign(
            {
              id: candidateConversation.id,
              mode: collaborationMode(candidateConversation),
              ...(candidateConversation.isolation
                ? { isolation: candidateConversation.isolation }
                : {}),
              settings: candidateConversation.settings,
              requestId: candidateConversation.requestId,
              workspaceId: candidateConversation.workspaceId,
              agentId: candidateConversation.agentId,
              title: summary.title,
              error: candidateConversation.error,
              ...(candidateConversation.disabledAt
                ? { disabledAt: candidateConversation.disabledAt }
                : {}),
            },
            summary.confirmation && !candidateConversation.disabledAt
              ? {
                  confirmation: {
                    kind: summary.confirmation.kind,
                    noticeId: summary.confirmation.noticeId,
                    mergeTargetBranch: summary.confirmation.mergeTargetBranch,
                  },
                }
              : {},
            summary.run ? { run: summarize(summary.run) } : {},
          );
        }),
      };
    } catch (error) {
      return {
        settings: null,
        conversations: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async command(command: CollaborationCommand, input: unknown): Promise<CollaborationState> {
    if (command === "status") return this.status();
    const { store, engine, conversations } = this.start();
    switch (command) {
      case "prompts.save": {
        const request = z
          .object({ prompts: RolePromptsSchema, base: RolePromptsSchema })
          .parse(input);
        store.saveRolePrompts(request.prompts, request.base);
        break;
      }
      case "settings.save": {
        const request = z
          .object({ settings: SettingsSchema, base: SettingsSchema.nullable() })
          .parse(input);
        store.commitSettings(request.settings, request.base, store.settingsDraft().revision);
        break;
      }
      case "conversation.open": {
        const request = openSchema.parse(input);
        if (request.settings) request.settings.rolePrompts = store.rolePrompts();
        await conversations.open(request);
        break;
      }
      case "conversation.resync":
        await conversations.resync(z.object({ id: z.string() }).parse(input).id);
        break;
      case "conversation.disable": {
        const request = z
          .object({ id: z.string(), cancelRunning: z.boolean().optional() })
          .parse(input);
        await conversations.disable(request.id, request);
        break;
      }
      case "conversation.confirm": {
        const request = z
          .object({ id: z.string(), sourceMessageId: z.string(), noticeId: z.string() })
          .parse(input);
        await conversations.confirm(request.id, request);
        break;
      }
      case "run.control": {
        const request = z
          .object({ id: z.string(), action: z.enum(["pause", "resume", "cancel", "retry"]) })
          .parse(input);
        await engine.control(request.id, request.action);
        break;
      }
      case "run.switch_executor": {
        const request = SwitchExecutorInputSchema.parse(input);
        await engine.switchExecutor(request.id, request);
        break;
      }
    }
    this.wake();
    return this.status();
  }
  tools(agentId: string): PaseoToolDefinition[] {
    const define = (
      name: string,
      description: string,
      inputSchema: z.ZodType,
      execute: (input: unknown) => Promise<unknown>,
    ): PaseoToolDefinition => ({
      name,
      description,
      inputSchema,
      handler: async (input) => {
        try {
          const value = await execute(inputSchema.parse(input));
          this.wake();
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          // Surface a refused call as a tool error so the model reads the reason (e.g. the
          // conversation has exited) instead of failing the whole turn.
          return {
            isError: true,
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
          };
        }
      },
    });
    const chat = () => {
      const runtime = this.start();
      const conversations = runtime.store.conversations();
      const conversation = conversations.find(
        (candidateConversation) =>
          candidateConversation.agentId === agentId && !candidateConversation.disabledAt,
      );
      if (!conversation) {
        // A closed main chat must not retry collaboration tools: tell it to behave as a normal chat.
        const closed = conversations.some(
          (candidateConversation) =>
            candidateConversation.agentId === agentId && candidateConversation.disabledAt,
        );
        throw new Error(
          closed
            ? "协作已在当前对话退出。请按普通聊天处理，不要重试协作工具或启动任务；如需协作请让用户重新启用。"
            : "请先在当前对话启用协作",
        );
      }
      return { ...runtime, id: conversation.id };
    };
    const submit = async (input: unknown, kind: "plan" | "execute" | "review") => {
      const parsed = z.object({ operationId: z.string(), payload: z.unknown() }).parse(input);
      const { store, engine } = this.start();
      const run = store
        .all()
        .find((candidateRun) => candidateRun.activeOperationId === parsed.operationId);
      const op = run?.operations.find(
        (candidateOperation) => candidateOperation.id === parsed.operationId,
      );
      if (!run || !op || op.agentId !== agentId) throw new Error("当前会话无权提交此操作");
      const expected = kind === "review" ? ["review", "final"] : [kind];
      if (!expected.includes(op.kind)) throw new Error("操作类型不匹配");
      const role = operationRole(run.settings, op.kind);
      let actor = "director";
      if (role === "worker") actor = op.taskId!;
      if (role === "reviewer") actor = REVIEWER_ACTOR;
      return engine.submit(run.id, actor, op.id, parsed.payload);
    };
    return [
      define(
        "get_conversation_status",
        "Read compact collaboration progress and the latest real user message. Request detail=operation only to recover the current instructions; plan, results, review, history and usage are available on demand. History, results and usage support offset/limit; detail=history with operationId reads one historical result. The user must enable collaboration first.",
        StatusOptionsSchema,
        async (input) => {
          const c = chat();
          return c.conversations.status(c.id, StatusOptionsSchema.parse(input));
        },
      ),
      define(
        "start_task",
        "Start a collaboration task only after an explicit implementation request, not a discussion. The user chooses the execution location when enabling collaboration; this tool cannot change it.",
        z.object({ sourceMessageId: z.string(), goal: z.string().trim().min(1).max(32000) }),
        async (input) => {
          const c = chat();
          return c.conversations.start(
            c.id,
            z.object({ sourceMessageId: z.string(), goal: z.string() }).parse(input),
          );
        },
      ),
      define(
        "submit_operation",
        "Report the current design or review result, including relevant file paths, to the same Paseo host managing this collaboration. The saved plan approval setting controls whether implementation starts after submission. This call does not grant user plan approval or result acceptance.",
        z.object({ operationId: z.string(), payload: z.union([PlanSchema, ReviewSchema]) }),
        async (input) => {
          const c = chat();
          const value = z.object({ operationId: z.string(), payload: z.unknown() }).parse(input);
          return c.conversations.submit(c.id, value.operationId, value.payload);
        },
      ),
      define(
        "control_task",
        "Control collaboration according to the latest user request. Approval requires a real user message and the current confirmation version. accept_final accepts “验收通过”; “验收并合并” also asks the host to commit and merge into the original branch without exiting collaboration. note records additional requirements in feedback without replanning; use revise only when the goal itself changes.",
        controlSchema,
        async (input) => {
          const c = chat();
          return c.conversations.control(c.id, controlSchema.parse(input));
        },
      ),
      define(
        "switch_execution_model",
        "Continue the same execution task after quota exhaustion only when the user explicitly selects another model. Reference the latest real user message, current execution operationId and execution.relay.token from get_conversation_status. Do not choose a model yourself. Authentication, unpaid balance, network and ordinary failures do not permit switching.",
        SwitchExecutionModelToolSchema,
        async (input) => {
          const c = chat();
          return c.conversations.switchExecutionModel(
            c.id,
            SwitchExecutionModelToolSchema.parse(input),
          );
        },
      ),
      define(
        "merge_result",
        "After acceptance, commit and merge into the original branch when the user replies with “合并成果” alone. For old tasks without a recorded original branch, the user replies “合并成果到 <target branch>”; pass targetBranch. Do not change a recorded original branch. Retry failures when requested; never push or deploy.",
        z.object({
          sourceMessageId: z.string(),
          targetBranch: z.string().trim().min(1).optional(),
        }),
        async (input) => {
          const c = chat();
          return c.conversations.merge(
            c.id,
            z
              .object({
                sourceMessageId: z.string(),
                targetBranch: z.string().trim().min(1).optional(),
              })
              .parse(input),
          );
        },
      ),
      define(
        "prepare_merge_recovery",
        "After a failed merge of an accepted result, let the main Agent obtain the repair scope, result and target workspaces, branches, errors and verification commands. Repair only the merge problem; do not discard or commit unrelated user changes. Call finish_merge_recovery afterward.",
        z.object({ sourceMessageId: z.string() }),
        async (input) => {
          const c = chat();
          return c.conversations.prepareMergeRecovery(
            c.id,
            z.object({ sourceMessageId: z.string() }).parse(input).sourceMessageId,
          );
        },
      ),
      define(
        "finish_merge_recovery",
        "After merge repair, submit the repair summary and current real user message ID. Retry delivery if the accepted snapshot is unchanged. Code changes return to implementation verification, review and user acceptance; do not bypass them.",
        z.object({ sourceMessageId: z.string(), summary: z.string().trim().min(1).max(16000) }),
        async (input) => {
          const c = chat();
          return c.conversations.finishMergeRecovery(
            c.id,
            z
              .object({ sourceMessageId: z.string(), summary: z.string().trim().min(1).max(16000) })
              .parse(input),
          );
        },
      ),
      define(
        "submit_plan",
        "Submit the current collaboration plan, including relevant file paths, to the same Paseo host managing this task. The saved plan approval setting controls whether implementation starts. This call does not grant user plan approval.",
        z.object({ operationId: z.string(), payload: PlanSchema }),
        (input) => submit(input, "plan"),
      ),
      define(
        "submit_result",
        "Report the current subtask result or blocker to the same Paseo host managing this collaboration for continued scheduling and review. This call does not grant final user acceptance.",
        z.object({ operationId: z.string(), payload: ResultSchema }),
        (input) => submit(input, "execute"),
      ),
      define(
        "submit_review",
        "Report the AI review decision for the current result snapshot to the same Paseo host managing this collaboration. User acceptance is still required after AI review approval.",
        z.object({ operationId: z.string(), payload: ReviewSchema }),
        (input) => submit(input, "review"),
      ),
      define(
        "get_run_status",
        "Read compact progress for this session. Request plan, results, review, history or usage in detail only as needed; lists support offset/limit.",
        StatusOptionsSchema,
        async (input) => {
          const { store } = this.start();
          const run = store
            .all()
            .find(
              (candidateRun) =>
                candidateRun.directorAgentId === agentId ||
                candidateRun.reviewerAgentId === agentId ||
                candidateRun.tasks.some((candidateTask) => candidateTask.agentId === agentId),
            );
          if (!run) throw new Error("当前会话不属于协作任务");
          return {
            ...runStatus(run),
            details: statusDetails(run, StatusOptionsSchema.parse(input), agentId),
            operationId: run.activeOperationId,
            tasks: run.tasks.map((candidateTask) => ({
              id: candidateTask.spec.id,
              status: candidateTask.status,
              executorId: candidateTask.profileId,
            })),
          };
        },
      ),
    ];
  }
  muteNotification(agentId: string, reason: string): boolean {
    if (!this.runtime) return false;
    return muteCollaborationNotification({
      agentId,
      reason,
      timeline: this.host.agentManager.getTimeline(agentId),
      runs: this.runtime.store.all(),
      // A closed conversation stops muting, so a canceled run's late notification is not swallowed.
      conversations: this.runtime.store.conversations().filter((c) => !c.disabledAt),
    });
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    if (!this.runtime) return;
    await this.runtime.engine.close();
    await this.pumping;
    await this.runtime.conversations.close();
    this.runtime.store.close();
    this.runtime = null;
  }
}
