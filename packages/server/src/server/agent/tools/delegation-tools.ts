import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { MutableDelegationConfig } from "@getpaseo/protocol/messages";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { ensureValidJson } from "../../json-utils.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export const DELEGATION_TOOL_NAMES = [
  "delegate_to_agent",
  "get_delegation_status",
  "cancel_delegation",
] as const;

/** Set on a delegated child when cancel_delegation stops it; the value is an ISO timestamp. */
export const DELEGATION_CANCELED_AT_LABEL = "paseo.delegation.canceled-at";
/** Marks a child created by delegate_to_agent. */
export const DELEGATION_TASK_LABEL = "paseo.delegation.task";

/** Prompt text links an agent as `[@Label](paseo://agent/<provider>)`. */
export const AGENT_MENTION_URL_PREFIX = "paseo://agent/";

const MAX_WAIT_MS = 60_000;
const WAIT_POLL_MS = 500;
const MAX_TASK_IDS = 16;

// Server-level MCP instructions reach the model even when a client defers tool schemas,
// so the mention convention lives here as well as on the tool.
export const DELEGATION_MCP_INSTRUCTIONS = [
  "Multi-agent delegation: the user can name another local AI agent in a message as `[@Name](paseo://agent/<provider>)`.",
  "Such a mention is an explicit instruction to delegate that part of the work with delegate_to_agent, using <provider> as the agent.",
  "When several agents are mentioned, make one delegate_to_agent call per agent, each carrying that agent's slice of the work.",
].join(" ");

export type DelegatedTaskStatus = "running" | "completed" | "failed" | "canceled" | "unknown";

export interface DelegatedAgentView {
  id: string;
  provider: string;
  lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
  labels: Record<string, string>;
  lastError?: string;
  lastUserMessageAt: Date | null;
  pendingPermissions: ReadonlyMap<string, { id: string; name: string; title?: string }>;
}

export interface DelegatedTaskEntry {
  taskId: string;
  status: DelegatedTaskStatus;
  agent?: string;
  blockedOn?: { kind: "permission"; id: string; title: string };
  result?: string | null;
  error?: string;
}

function isCanceled(agent: DelegatedAgentView): boolean {
  const canceledAt = Date.parse(agent.labels[DELEGATION_CANCELED_AT_LABEL] ?? "");
  if (Number.isNaN(canceledAt)) return false;
  // A prompt sent after the cancel (for example a send_agent_prompt follow-up) starts a new run.
  return !agent.lastUserMessageAt || agent.lastUserMessageAt.getTime() <= canceledAt;
}

/** A tab title for a delegated child: the task's first line. */
export function delegatedTaskTitle(task: string): string {
  const firstLine = task.trim().split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine;
}

export function projectDelegatedTask(
  taskId: string,
  agent: DelegatedAgentView | null,
  callerAgentId: string,
): DelegatedTaskEntry {
  if (!agent || getParentAgentIdFromLabels(agent.labels) !== callerAgentId) {
    return { taskId, status: "unknown" };
  }
  const base = { taskId, agent: agent.provider };
  if (agent.lifecycle === "initializing" || agent.lifecycle === "running") {
    const permission = agent.pendingPermissions.values().next().value;
    return {
      ...base,
      status: "running",
      ...(permission
        ? {
            blockedOn: {
              kind: "permission" as const,
              id: permission.id,
              title: permission.title ?? permission.name,
            },
          }
        : {}),
    };
  }
  if (agent.lifecycle === "closed" || isCanceled(agent)) return { ...base, status: "canceled" };
  if (agent.lifecycle === "error") {
    return { ...base, status: "failed", error: agent.lastError ?? "The agent failed" };
  }
  return { ...base, status: "completed" };
}

function isTerminal(entry: DelegatedTaskEntry): boolean {
  return entry.status !== "running";
}

/** How many delegating ancestors sit above an agent. A root agent is at depth 0. */
export function resolveDelegationDepth(
  agentId: string,
  getAgent: (id: string) => { labels: Record<string, string> } | null | undefined,
): number {
  let depth = 0;
  const seen = new Set([agentId]);
  let parentId = getParentAgentIdFromLabels(getAgent(agentId)?.labels);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = getParentAgentIdFromLabels(getAgent(parentId)?.labels);
  }
  return depth;
}

/** Whether an agent at `callerDepth` may create a delegated child. */
export function canDelegateAtDepth(
  config: MutableDelegationConfig | undefined,
  callerDepth: number,
): boolean {
  if (config?.enabled === false) return false;
  return callerDepth + 1 <= (config?.depthLimit ?? 1);
}

export interface DelegationToolsOptions {
  callerAgentId: string;
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  readConfig: () => MutableDelegationConfig | undefined;
  /** Enabled provider ids the caller may delegate to. */
  listProviders: () => string[];
  getAgent: (agentId: string) => DelegatedAgentView | null;
  getLastAssistantMessage: (agentId: string) => Promise<string | null>;
  createChild: (input: {
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    task: string;
    cwd?: string;
    labels: Record<string, string>;
  }) => Promise<{ agentId: string }>;
  cancelRun: (agentId: string) => Promise<void>;
  setLabels: (agentId: string, labels: Record<string, string>) => Promise<void>;
}

function toolResult(value: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(value) };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // An abort ends the wait early; the caller's loop checks the signal.
  await delay(ms, undefined, { signal }).catch(() => undefined);
}

// A permission wakes a wait once. Keyed by caller and task so repeated waits do not spin
// on a prompt the caller has already been told about.
const reportedPermissions = new Map<string, string>();

export function registerDelegationTools(options: DelegationToolsOptions): void {
  const { callerAgentId } = options;
  const config = options.readConfig();
  const depth = resolveDelegationDepth(callerAgentId, options.getAgent);
  if (!canDelegateAtDepth(config, depth)) return;
  const providers = options.listProviders();
  if (providers.length === 0) return;

  const withResult = async (entry: DelegatedTaskEntry): Promise<DelegatedTaskEntry> => {
    if (entry.status !== "completed" && entry.status !== "failed" && entry.status !== "canceled") {
      return entry;
    }
    return { ...entry, result: await options.getLastAssistantMessage(entry.taskId) };
  };

  const snapshot = (taskIds: readonly string[]) =>
    taskIds.map((taskId) => projectDelegatedTask(taskId, options.getAgent(taskId), callerAgentId));

  const isNewlyBlocked = (entry: DelegatedTaskEntry): boolean =>
    !!entry.blockedOn &&
    reportedPermissions.get(`${callerAgentId}:${entry.taskId}`) !== entry.blockedOn.id;

  options.registerTool(
    "delegate_to_agent",
    {
      title: "Delegate to agent",
      description: [
        "Hand off a self-contained sub-task to a separate local AI agent that runs in its own session, visible to the user as your subagent.",
        "ASYNCHRONOUS: returns a taskId right away while the sub-agent keeps working, so you can fan out several delegations and keep working, then collect results with get_delegation_status (pass every taskId at once) or stop one with cancel_delegation.",
        "The sub-agent CANNOT see this conversation, your open files, or earlier turns. It starts cold, so `task` must carry everything it needs.",
        "Best for independent work you can describe up front. To follow up on a finished task in the same session, call send_agent_prompt with the taskId as agentId.",
        `RECOGNIZING AN EXPLICIT DELEGATION REQUEST: the user can name an agent in their message as a Markdown link \`[@Name](${AGENT_MENTION_URL_PREFIX}<provider>)\`. Such a mention IS an instruction to delegate the associated work to that agent, even when the user never names this tool. If the message names several agents, make one call per agent.`,
      ].join(" "),
      inputSchema: {
        agent: z
          .enum(providers as [string, ...string[]])
          .describe(
            `Which local agent runs the sub-task. When the user mentioned \`${AGENT_MENTION_URL_PREFIX}<provider>\`, use that exact <provider>.`,
          ),
        task: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The complete, self-contained prompt for the sub-agent: the goal, relevant background and absolute file paths, constraints, and exactly what to return.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Absolute path the sub-agent runs in. Defaults to your working directory."),
      },
      outputSchema: {
        taskId: z.string(),
        agent: z.string(),
        status: z.string(),
        guidance: z.string(),
      },
    },
    async ({ agent, task, cwd }: { agent: string; task: string; cwd?: string }) => {
      const current = options.readConfig();
      if (!canDelegateAtDepth(current, resolveDelegationDepth(callerAgentId, options.getAgent))) {
        throw new Error("Delegation is turned off or the delegation depth limit is reached");
      }
      const defaults = current?.agentDefaults?.[agent];
      const { agentId } = await options.createChild({
        provider: agent,
        ...(defaults?.model ? { model: defaults.model } : {}),
        ...(defaults?.modeId ? { modeId: defaults.modeId } : {}),
        ...(defaults?.thinkingOptionId ? { thinkingOptionId: defaults.thinkingOptionId } : {}),
        task,
        ...(cwd ? { cwd } : {}),
        labels: { [DELEGATION_TASK_LABEL]: "true" },
      });
      return toolResult({
        taskId: agentId,
        agent,
        status: "running",
        guidance:
          "The sub-agent is working. You will be notified when it finishes, errors, or needs permission; you can also collect the result with get_delegation_status.",
      });
    },
  );

  options.registerTool(
    "get_delegation_status",
    {
      title: "Get delegation status",
      description: [
        "Collect or check delegated task results by the taskIds from delegate_to_agent. Always returns {tasks:[...]}, one entry per id in the order given.",
        "Omit waitMs for an immediate snapshot. waitMs>0 blocks up to that many ms (capped at 60000); waitMs=0 blocks until something happens.",
        "A wait returns as soon as ANY requested task reaches completed, failed or canceled, so drop collected ids and call again for the rest.",
        "A wait also returns when a task becomes blocked on the user (status stays running, with blockedOn): tell the user, then wait again. Each distinct prompt wakes the wait once.",
        "While tasks are simply still running, do not narrate waiting to the user; call again silently.",
      ].join(" "),
      inputSchema: {
        taskIds: z.array(z.string()).min(1).max(MAX_TASK_IDS),
        waitMs: z.number().int().min(0).optional(),
      },
      outputSchema: {
        tasks: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async (
      { taskIds, waitMs }: { taskIds: string[]; waitMs?: number },
      context: PaseoToolExecutionContext,
    ) => {
      let entries = snapshot(taskIds);
      if (waitMs !== undefined) {
        const deadline = waitMs === 0 ? Infinity : Date.now() + Math.min(waitMs, MAX_WAIT_MS);
        while (
          !entries.some((entry) => isTerminal(entry) || isNewlyBlocked(entry)) &&
          Date.now() < deadline &&
          !context.signal?.aborted
        ) {
          await sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()), context.signal);
          entries = snapshot(taskIds);
        }
        for (const entry of entries) {
          if (entry.blockedOn) {
            reportedPermissions.set(`${callerAgentId}:${entry.taskId}`, entry.blockedOn.id);
          }
        }
      }
      return toolResult({ tasks: await Promise.all(entries.map(withResult)) });
    },
  );

  options.registerTool(
    "cancel_delegation",
    {
      title: "Cancel delegation",
      description:
        "Stop a running delegated task by its taskId. Use it only when you no longer want the result; long work is normal, so prefer waiting. A task that already finished is left alone and its result is returned.",
      inputSchema: { taskId: z.string() },
      outputSchema: { task: z.record(z.string(), z.unknown()) },
    },
    async ({ taskId }: { taskId: string }) => {
      const entry = projectDelegatedTask(taskId, options.getAgent(taskId), callerAgentId);
      if (entry.status === "unknown") throw new Error(`Unknown delegated task: ${taskId}`);
      if (isTerminal(entry)) return toolResult({ task: await withResult(entry) });
      await options.setLabels(taskId, { [DELEGATION_CANCELED_AT_LABEL]: new Date().toISOString() });
      await options.cancelRun(taskId);
      const canceled = projectDelegatedTask(taskId, options.getAgent(taskId), callerAgentId);
      return toolResult({ task: await withResult(canceled) });
    },
  );
}
