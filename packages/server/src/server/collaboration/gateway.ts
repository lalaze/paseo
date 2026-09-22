import type { Logger } from "pino";
import { realpath } from "node:fs/promises";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { Conversation } from "@getpaseo/protocol/collaboration/conversation";
import {
  operationLabel,
  operationRole,
  type Operation,
  type Profile,
  type Run,
} from "@getpaseo/protocol/collaboration/schema";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { createAgentCommand } from "../agent/create-agent/create.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { AgentGateway, AgentSnapshot } from "./engine.js";
import type { ConversationGateway } from "./conversations.js";
import { CHAT_PROMPT, ROLE_PROMPT } from "./prompts.js";

export const CHAT_TOOLS = [
  "get_conversation_status",
  "start_task",
  "submit_operation",
  "control_task",
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
  assertToolsEnabled: (agentId: string, tools?: readonly string[]) => void;
  logger: Logger;
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

export class CollaborationGateway implements AgentGateway, ConversationGateway {
  constructor(
    private host: CollaborationHost,
    private legacyMcpPort?: number,
  ) {}
  private async load(agentId: string) {
    const record = await this.host.agentStorage.get(agentId);
    if (record?.archivedAt) throw new Error("会话已归档，请先恢复会话");
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
    const { snapshot } = await this.host.createAgent({
      kind: "mcp",
      provider: profile.provider,
      title,
      workspaceId,
      cwd: await this.workspaceDirectory(workspaceId),
      config: { systemPrompt },
      features: profile.featureValues,
      mode: profile.modeId,
      thinking: profile.thinkingOptionId,
      labels,
      background: true,
      notifyOnFinish: false,
      callerAgentId: parent,
    });
    this.host.assertToolsEnabled(snapshot.id, ROLE_TOOLS[labels["director-role"]]);
    return snapshot.id;
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
    return {
      status,
      ...inspectMessages(await this.conversationHistory(agentId), operationId),
      error: agent.lastError,
    };
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
  async createConversation(c: Conversation) {
    const profile = c.settings.profiles.find(
      (candidateProfile) => candidateProfile.id === c.settings.directorProfileId,
    );
    if (!profile) throw new Error("主 Agent 配置不存在");
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
      CHAT_PROMPT + (profile.instructions ? `\n用户补充要求：\n${profile.instructions}` : ""),
    );
  }
  async appendConversationLink(agentId: string, _conversationId: string) {
    await this.load(agentId);
  }
  async stop(agentId: string) {
    await this.load(agentId);
    await this.host.agentManager.cancelAgentRun(agentId);
  }
}
