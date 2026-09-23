import { migrateNativeCollaboration } from "./migration.js";
import { muteCollaborationNotification } from "./notifications.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  CollaborationCommand,
  CollaborationState,
} from "@getpaseo/protocol/collaboration/rpc";
import {
  PlanSchema,
  ResultSchema,
  ReviewSchema,
  SettingsSchema,
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
import { workflowEvidence } from "./workflow-evidence.js";

const openSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().optional(),
  goal: z.string().max(32000).optional(),
  fresh: z.boolean().optional(),
  mode: CollaborationModeSchema.optional(),
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
    const engine = new Engine(store, gateway, new GitRepository(this.root));
    const conversations = new Conversations(store, engine, gateway);
    this.runtime = { store, engine, conversations };
    this.unsubscribe = this.host.agentManager.subscribe(
      (event) => {
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
        error: null,
        conversations: store.conversations().map((candidateConversation) => {
          const summary = conversations.summary(candidateConversation.id);
          return Object.assign(
            {
              id: candidateConversation.id,
              mode: collaborationMode(candidateConversation),
              requestId: candidateConversation.requestId,
              workspaceId: candidateConversation.workspaceId,
              agentId: candidateConversation.agentId,
              title: summary.title,
              error: candidateConversation.error,
            },
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
      case "settings.save": {
        const request = z
          .object({ settings: SettingsSchema, base: SettingsSchema.nullable() })
          .parse(input);
        store.commitSettings(request.settings, request.base, store.settingsDraft().revision);
        break;
      }
      case "conversation.open":
        await conversations.open(openSchema.parse(input));
        break;
      case "conversation.resync":
        await conversations.resync(z.object({ id: z.string() }).parse(input).id);
        break;
      case "run.control": {
        const request = z
          .object({ id: z.string(), action: z.enum(["pause", "resume", "cancel", "retry"]) })
          .parse(input);
        await engine.control(request.id, request.action);
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
        const value = await execute(inputSchema.parse(input));
        this.wake();
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      },
    });
    const chat = () => {
      const runtime = this.start();
      const conversation = runtime.store
        .conversations()
        .find((candidateConversation) => candidateConversation.agentId === agentId);
      if (!conversation) throw new Error("请先在当前对话启用协作");
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
        "读取当前协作任务、操作上下文和最新真实用户消息。需先由用户启用协作。",
        z.object({}),
        async () => {
          const c = chat();
          return c.conversations.status(c.id);
        },
      ),
      define(
        "start_task",
        "在用户明确要求实施后启动协作任务；讨论不启动。",
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
        "提交主对话当前设计或审核结果。",
        z.object({ operationId: z.string(), payload: z.union([PlanSchema, ReviewSchema]) }),
        async (input) => {
          const c = chat();
          const value = z.object({ operationId: z.string(), payload: z.unknown() }).parse(input);
          return c.conversations.submit(c.id, value.operationId, value.payload);
        },
      ),
      define(
        "control_task",
        "按最新用户要求控制协作；批准需要真实用户消息与当前确认版本。",
        controlSchema,
        async (input) => {
          const c = chat();
          return c.conversations.control(c.id, controlSchema.parse(input));
        },
      ),
      define(
        "submit_plan",
        "提交当前协作计划。",
        z.object({ operationId: z.string(), payload: PlanSchema }),
        (input) => submit(input, "plan"),
      ),
      define(
        "submit_result",
        "提交当前子任务成果或阻塞原因。",
        z.object({ operationId: z.string(), payload: ResultSchema }),
        (input) => submit(input, "execute"),
      ),
      define(
        "submit_review",
        "提交当前成果快照的审核决定。",
        z.object({ operationId: z.string(), payload: ReviewSchema }),
        (input) => submit(input, "review"),
      ),
      define("get_run_status", "读取当前会话所属协作任务。", z.object({}), async () => {
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
          ...summarize(run),
          workflowEvidence: workflowEvidence(run),
          operationId: run.activeOperationId,
          tasks: run.tasks.map((candidateTask) => ({
            id: candidateTask.spec.id,
            status: candidateTask.status,
            executorId: candidateTask.profileId,
          })),
        };
      }),
    ];
  }
  muteNotification(agentId: string, reason: string): boolean {
    if (!this.runtime) return false;
    return muteCollaborationNotification({
      agentId,
      reason,
      timeline: this.host.agentManager.getTimeline(agentId),
      runs: this.runtime.store.all(),
      conversations: this.runtime.store.conversations(),
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
