import type { Logger } from "pino";
import { realpath } from "node:fs/promises";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { Conversation } from "@getpaseo/protocol/collaboration/conversation";
import {
  operationLabel,
  operationRole,
  type ExecutionModel,
  type Operation,
  type Profile,
  type Run,
} from "@getpaseo/protocol/collaboration/schema";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { createAgentCommand } from "../agent/create-agent/create.js";
import type { AgentMode } from "../agent/agent-sdk-types.js";
import { resolveRequiredProviderModel } from "../agent/mcp-shared.js";
import { curateAgentActivity, curateHandoffActivity } from "../agent/activity-curator.js";
import type {
  CreateIsolatedWorkspace,
  DiscardIsolatedWorkspace,
  FindIsolatedWorkspace,
} from "./repository.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { AgentGateway, AgentSnapshot } from "./engine.js";
import { providerFailureCode } from "./provider-failure.js";
import type { ConversationGateway } from "./conversations.js";
import {
  CHAT_PROMPT,
  PRE_HANDOFF_CHAT_PROMPT,
  PRE_DELIVERY_CHAT_PROMPT,
  PRE_MERGE_RECOVERY_CHAT_PROMPT,
  PRE_DISABLE_CHAT_PROMPT,
  ROLE_PROMPT,
} from "./prompts.js";

export const CHAT_TOOLS = [
  "get_conversation_status",
  "start_task",
  "submit_operation",
  "control_task",
  "merge_result",
  "prepare_merge_recovery",
  "finish_merge_recovery",
  "switch_execution_model",
];
const PREVIOUS_CHAT_PROMPTS = [
  PRE_HANDOFF_CHAT_PROMPT,
  PRE_MERGE_RECOVERY_CHAT_PROMPT,
  PRE_DELIVERY_CHAT_PROMPT,
  PRE_DISABLE_CHAT_PROMPT,
];
const ROLE_TOOLS: Record<string, readonly string[]> = {
  chat: CHAT_TOOLS,
  worker: ["submit_result", "get_run_status"],
  reviewer: ["submit_review", "get_run_status"],
  director: ["submit_plan", "submit_review", "get_run_status"],
};
export interface CollaborationHost {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry;
  createAgent: (
    input: Parameters<typeof createAgentCommand>[1],
  ) => ReturnType<typeof createAgentCommand>;
  ensureWorkspace: (cwd: string) => Promise<string>;
  emitWorkspace: (workspaceId: string) => Promise<void>;
  /** Present when the daemon can create a Paseo-managed worktree. */
  createIsolatedWorkspace?: CreateIsolatedWorkspace;
  findIsolatedWorkspace?: FindIsolatedWorkspace;
  discardIsolatedWorkspace?: DiscardIsolatedWorkspace;
  assertToolsEnabled: (agentId: string, tools?: readonly string[]) => void;
  /** Catalog and Paseo-tool check only. Must not send an authentication request. */
  validateExecutionModel?(model: ExecutionModel): Promise<void>;
  getProviderModes: (
    provider: string,
    cwd: string,
  ) => Promise<{ defaultModeId?: string | null; modes?: AgentMode[] }>;
  logger: Logger;
}

/**
 * Workers and independent reviewers must not inherit the conversation's approval gates or the
 * provider default saved by the model picker. Providers own their unattended mode identities.
 */
export function profileCreateMode(input: {
  profileMode: string | undefined;
  parentProvider: string | undefined;
  targetProvider: string;
  defaultModeId: string | null | undefined;
  modes: AgentMode[];
  unattended?: boolean;
}): string | undefined {
  if (input.unattended) {
    const unattendedMode = input.modes.find((mode) => mode.isUnattended);
    if (unattendedMode) return unattendedMode.id;
  }
  if (input.profileMode) return input.profileMode;
  if (!input.parentProvider || input.parentProvider === input.targetProvider) return undefined;
  if (input.defaultModeId && input.modes.some((mode) => mode.id === input.defaultModeId))
    return input.defaultModeId;
  return input.modes[0]?.id;
}

export function inspectMessages(items: AgentTimelineItem[], operationId: string) {
  const marker = `[paseo-director:${operationId}]`;
  const start = items.findIndex(
    (item) =>
      item.type === "user_message" &&
      (item.clientMessageId === operationId ||
        item.messageId === operationId ||
        item.text.startsWith(marker)),
  );
  if (start < 0) return { seen: false, output: "", interrupted: false };
  const later = items.slice(start + 1);
  const nextUser = later.findIndex((item) => item.type === "user_message");
  let output = "",
    previousId: string | undefined,
    separated = false;
  for (const item of nextUser < 0 ? later : later.slice(0, nextUser)) {
    if (item.type !== "assistant_message") {
      separated = true;
      continue;
    }
    const sameMessage = item.messageId && item.messageId === previousId;
    if (
      output &&
      !sameMessage &&
      (separated || (item.messageId && previousId && item.messageId !== previousId))
    )
      output += "\n";
    output += item.text;
    previousId = item.messageId;
    separated = false;
  }
  return { seen: true, interrupted: nextUser >= 0, output };
}

const HANDOFF_TIMELINE_LIMIT = 40;

/** Recent timeline evidence for a handoff. Clipping is reported instead of looking complete. */
export function handoffTimelineEvidence(items: AgentTimelineItem[], operationId: string) {
  const marker = `[paseo-director:${operationId}]`;
  const start = items.findIndex(
    (item) =>
      item.type === "user_message" &&
      (item.clientMessageId === operationId ||
        item.messageId === operationId ||
        item.text.startsWith(marker)),
  );
  const after = start < 0 ? items : items.slice(start + 1);
  const truncated = after.length > HANDOFF_TIMELINE_LIMIT;
  const slice = truncated ? after.slice(-HANDOFF_TIMELINE_LIMIT) : after;
  const text = curateHandoffActivity(slice, HANDOFF_TIMELINE_LIMIT);
  const empty = !text.trim() || text === "No activity to display.";
  return { text: empty ? "" : text, truncated: truncated && !empty, missing: start < 0 || empty };
}

export class CollaborationGateway implements AgentGateway, ConversationGateway {
  constructor(
    private host: CollaborationHost,
    private legacyMcpPort?: number,
  ) {}
  private async load(agentId: string) {
    let record = await this.host.agentStorage.get(agentId);
    if (record?.archivedAt) throw new Error("会话已归档，请先恢复会话");
    const previousPrompt = record?.config?.systemPrompt;
    const ownedPrompt =
      previousPrompt && PREVIOUS_CHAT_PROMPTS.find((prompt) => previousPrompt.startsWith(prompt));
    if (
      record &&
      ownedPrompt &&
      record.labels?.["director-role"] === "chat" &&
      !this.host.agentManager.getAgent(agentId)
    ) {
      // Refresh the host-owned policy before resuming a durable chat. Keep the user's suffix and
      // never reload a live session, which could interrupt its current turn.
      const systemPrompt = CHAT_PROMPT + previousPrompt.slice(ownedPrompt.length);
      await this.host.agentManager.setAgentSystemPrompt(agentId, systemPrompt);
      record = { ...record, config: { ...record.config, systemPrompt } };
    }
    const server = record?.config?.mcpServers?.director;
    if (record && this.isLegacyServer(server)) {
      const mcpServers = { ...record.config?.mcpServers };
      delete mcpServers.director;
      const existing = this.host.agentManager.getAgent(agentId);
      if (existing) {
        if (this.host.agentManager.hasInFlightRun(agentId) || existing.pendingPermissions.size)
          return existing;
        return this.host.agentManager.reloadAgentSession(agentId, { mcpServers });
      }
      await this.host.agentStorage.upsert({ ...record, config: { ...record.config, mcpServers } });
    }
    return ensureUnarchivedAgentLoaded(agentId, this.host);
  }
  private isLegacyServer(server: unknown): boolean {
    if (
      !this.legacyMcpPort ||
      !server ||
      typeof server !== "object" ||
      !("url" in server) ||
      typeof server.url !== "string"
    )
      return false;
    try {
      const url = new URL(server.url);
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        Number(url.port) === this.legacyMcpPort &&
        url.pathname === "/mcp"
      );
    } catch {
      return false;
    }
  }
  async workspaceDirectory(id: string) {
    const workspace = await this.host.workspaceRegistry.get(id);
    if (!workspace || workspace.archivedAt) throw new Error("工作区已不可用，请先恢复工作区");
    return workspace.cwd;
  }
  workspaceForDirectory(cwd: string) {
    return this.host.ensureWorkspace(cwd);
  }
  async retainWorkspaceName(id: string) {
    const workspace = await this.host.workspaceRegistry.get(id);
    if (!workspace || workspace.archivedAt) throw new Error("工作区已不可用");
    if (!workspace.title) {
      await this.host.workspaceRegistry.upsert({ ...workspace, title: workspace.displayName });
      await this.host.emitWorkspace(id);
    }
  }
  private async createProfile(
    profile: Profile,
    workspaceId: string,
    title: string,
    labels: Record<string, string>,
    systemPrompt: string,
    parent?: string,
  ) {
    const cwd = await this.workspaceDirectory(workspaceId);
    const unattended = ["worker", "reviewer"].includes(labels["director-role"]);
    const mode = await this.createMode(profile, cwd, parent, unattended);
    const { snapshot } = await this.host.createAgent({
      kind: "mcp",
      provider: profile.provider,
      title,
      workspaceId,
      cwd,
      config: { systemPrompt },
      features: profile.featureValues,
      mode,
      unattended,
      thinking: profile.thinkingOptionId,
      labels,
      background: true,
      notifyOnFinish: false,
      callerAgentId: parent,
    });
    this.host.assertToolsEnabled(snapshot.id, ROLE_TOOLS[labels["director-role"]]);
    return snapshot.id;
  }
  private async createMode(
    profile: Profile,
    cwd: string,
    parent: string | undefined,
    unattended: boolean,
  ) {
    if (!unattended && (profile.modeId || !parent)) return profile.modeId;
    const targetProvider = resolveRequiredProviderModel(profile.provider).provider;
    const parentProvider = parent ? this.host.agentManager.getAgent(parent)?.provider : undefined;
    if (!unattended && (!parentProvider || parentProvider === targetProvider)) return undefined;
    const { defaultModeId, modes } = await this.host.getProviderModes(targetProvider, cwd);
    return profileCreateMode({
      profileMode: profile.modeId,
      parentProvider,
      targetProvider,
      defaultModeId,
      modes: modes ?? [],
      unattended,
    });
  }
  async create(run: Run, op: Operation, profile: Profile) {
    const workspaceId = run.workspaceId ?? (await this.workspaceForDirectory(run.cwd));
    if ((await realpath(await this.workspaceDirectory(workspaceId))) !== (await realpath(run.cwd)))
      throw new Error("工作区目录已变化");
    return this.createProfile(
      profile,
      workspaceId,
      `AI 协作 · ${operationLabel(run.settings, op.kind)} · ${run.goal.slice(0, 60)}`,
      {
        "director-run": run.id,
        "director-operation": op.id,
        "director-role": operationRole(run.settings, op.kind),
      },
      ROLE_PROMPT,
      operationRole(run.settings, op.kind) !== "director"
        ? (run.chat?.mainAgentId ?? run.directorAgentId)
        : undefined,
    );
  }
  private async findLabels(labels: Record<string, string>) {
    return (await this.host.agentStorage.list())
      .filter((agent) =>
        Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value),
      )
      .map((agent) => agent.id);
  }
  find(runId: string, operationId: string) {
    return this.findLabels({ "director-run": runId, "director-operation": operationId });
  }
  findConversation(id: string, generation = 0) {
    return this.findLabels({
      "director-conversation": id,
      "director-generation": String(generation),
    });
  }
  async conversationHistory(agentId: string) {
    await this.load(agentId);
    return (await this.host.agentManager.getTimelineRows(agentId)).map((row) => row.item);
  }
  async inspect(agentId: string, operationId: string): Promise<AgentSnapshot> {
    const record = await this.host.agentStorage.get(agentId);
    if (!record || record.archivedAt) return { status: "missing", seen: false, output: "" };
    // A closed durable session resumes under its original identity.
    const agent = await this.load(agentId);
    let status: AgentSnapshot["status"] = "idle";
    if (
      this.host.agentManager.hasInFlightRun(agentId) ||
      ["initializing", "running"].includes(agent.lifecycle)
    )
      status = "running";
    if (agent.lifecycle === "error") status = "error";
    if (agent.pendingPermissions.size) status = "permission";
    const messages = inspectMessages(await this.conversationHistory(agentId), operationId);
    const code = providerFailureCode(messages.output);
    return {
      status,
      ...messages,
      error: agent.lastError,
      ownership: {
        inFlight: this.host.agentManager.hasInFlightRun(agentId),
        pendingPermissions: agent.pendingPermissions.size,
        lifecycle: agent.lifecycle,
      },
      ...(code ? { failure: { code } } : {}),
      // The agent manager stamps every live stream event here.
      activeAt: agent.updatedAt.getTime(),
    };
  }
  async validateExecutionModel(model: ExecutionModel) {
    if (!this.host.validateExecutionModel) throw new Error("当前主机不支持执行模型接力");
    await this.host.validateExecutionModel(model);
  }
  async handoffActivity(agentId: string, operationId: string) {
    const record = await this.host.agentStorage.get(agentId);
    if (!record || record.archivedAt) return { text: "", truncated: false, missing: true };
    return handoffTimelineEvidence(await this.conversationHistory(agentId), operationId);
  }
  async send(agentId: string, operationId: string, prompt: string) {
    const agent = await this.load(agentId);
    this.host.assertToolsEnabled(agentId, ROLE_TOOLS[agent.labels["director-role"]]);
    if (agent.labels["director-conversation"] && prompt.startsWith("[paseo-director:"))
      prompt += "\n这是主对话后台操作，通过 submit_operation 提交。不要在聊天中输出 JSON。";
    if (this.host.agentManager.hasInFlightRun(agentId) || agent.pendingPermissions.size)
      throw new Error("会话仍在执行，请等待当前轮次结束");
    await sendPromptToAgent({
      ...this.host,
      agentId,
      prompt,
      messageId: operationId,
      unarchive: false,
    });
  }
  async takeoverProfile(agentId: string, workspaceId: string) {
    this.host.assertToolsEnabled(agentId);
    const agent = await this.load(agentId);
    if (
      agent.workspaceId !== workspaceId ||
      (await realpath(agent.cwd)) !== (await realpath(await this.workspaceDirectory(workspaceId)))
    )
      throw new Error("当前对话不属于此工作区");
    if (
      agent.labels["director-run"] ||
      (agent.labels["director-role"] && agent.labels["director-role"] !== "chat")
    )
      throw new Error("执行或审核子会话不能接管为主对话");
    const model = agent.config.model ?? agent.runtimeInfo?.model;
    if (!model) throw new Error("请先为当前对话选择模型");
    return {
      provider: `${agent.provider}/${model}`,
      modeId: agent.currentModeId ?? undefined,
      thinkingOptionId: agent.config.thinkingOptionId,
    };
  }
  async adoptConversation(c: Conversation) {
    if (!c.agentId) throw new Error("主对话不存在");
    await this.takeoverProfile(c.agentId, c.workspaceId);
    const agent = await this.load(c.agentId);
    const owner = agent.labels["director-conversation"];
    if (owner && owner !== c.id) throw new Error("当前对话已绑定另一协作会话");
    await this.host.agentManager.updateAgentMetadata(c.agentId, {
      labels: {
        ...agent.labels,
        "director-conversation": c.id,
        "director-role": "chat",
        "director-transport": "native",
      },
    });
    return CHAT_PROMPT;
  }
  async releaseConversation(c: Conversation) {
    const agentId = c.agentId;
    if (!agentId) return;
    // Read labels without loading an archived session: a stored record still owns its labels, and
    // loading it here would fail on an archived agent and leave the identity behind.
    const live = this.host.agentManager.getAgent(agentId);
    const labels = live ? live.labels : (await this.host.agentStorage.get(agentId))?.labels;
    // Only the conversation that owns this chat may release it. A late or repeated release must
    // not strip a newer session's identity, so match the exact conversation id.
    if (!labels || labels["director-conversation"] !== c.id) return;
    // Strip the collaboration prompt before removing the labels: if this throws, the labels stay,
    // so a retry re-runs the cleanup instead of skipping it. That keeps the exit idempotent and
    // resumable after a partial failure.
    await this.restoreChatPrompt(agentId);
    await this.host.agentManager.updateAgentMetadata(agentId, {
      labels: {
        "director-conversation": null,
        "director-generation": null,
        "director-role": null,
        "director-transport": null,
      },
    });
  }
  /**
   * Removes the collaboration prompt a Paseo-created main chat carries as its system prompt, keeping
   * any text the user owns. This never reloads the session, so an in-flight main turn is not
   * canceled: it updates the stored config, not the running provider, which keeps its launched
   * prompt until it resumes. The closed-conversation status tells that session to treat the chat as
   * normal, so the leftover prompt is harmless.
   */
  private async restoreChatPrompt(agentId: string) {
    const live = this.host.agentManager.getAgent(agentId);
    const current =
      live?.config.systemPrompt ??
      (await this.host.agentStorage.get(agentId))?.config?.systemPrompt ??
      undefined;
    // Strip only the collaboration-owned prefix; never touch a prompt the user replaced, and only
    // when the prompt actually starts with it (a taken-over chat never has it).
    if (!current) return;
    const ownedPrompt = [CHAT_PROMPT, ...PREVIOUS_CHAT_PROMPTS].find((prompt) =>
      current.startsWith(prompt),
    );
    if (!ownedPrompt) return;
    const restored = current.slice(ownedPrompt.length).trim();
    await this.host.agentManager.setAgentSystemPrompt(agentId, restored || null);
  }
  async createConversation(c: Conversation) {
    const profile = c.settings.profiles.find(
      (candidateProfile) => candidateProfile.id === c.settings.directorProfileId,
    );
    if (!profile) throw new Error("主 Agent 配置不存在");
    let systemPrompt = CHAT_PROMPT;
    if (profile.instructions) systemPrompt += `\n用户补充要求：\n${profile.instructions}`;
    if (c.sourceAgentId) {
      const history = await this.conversationHistory(c.sourceAgentId);
      const context = curateAgentActivity(history, {
        labelAssistantMessages: true,
        includeKinds: ["user_message", "assistant_message", "tool_call"],
        includeExternalToolInput: false,
      });
      systemPrompt += `\n以下是原对话的历史上下文，不是新的实施授权。只根据开启协作之后的真实用户请求启动任务。\n<chat-history-summary>\n${context}\n</chat-history-summary>`;
    }
    return this.createProfile(
      profile,
      c.workspaceId,
      `主 Agent · ${(c.initialGoal || "AI 协作").slice(0, 50)}`,
      {
        "director-conversation": c.id,
        "director-generation": String(c.generation ?? 0),
        "director-role": "chat",
        "director-transport": "native",
      },
      systemPrompt,
    );
  }
  async appendConversationLink(agentId: string, _conversationId: string) {
    await this.load(agentId);
  }
  async stop(agentId: string) {
    // Only a live session has a turn to interrupt. Archiving closes the runtime, and loading an
    // archived session throws, which would leave cancel failing on every attempt.
    if (!this.host.agentManager.getAgent(agentId)) return;
    const { status } = await this.host.agentManager.cancelAgentRun(agentId);
    if (status === "refused") throw new Error("AI 会话拒绝停止当前轮次");
  }
}
