import { test, expect } from "vitest";
import { z } from "zod";
import { mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  readCollaborationNotice,
  readCollaborationPrompt,
} from "@getpaseo/protocol/collaboration/presentation";
import { finalAcceptance, SettingsSchema } from "@getpaseo/protocol/collaboration/schema";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "../agent/agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSessionConfig,
  AgentPersistenceHandle,
} from "../agent/agent-sdk-types.js";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import { Store } from "./store.js";
import { plan, result } from "./test-utils/harness.js";
import {
  CHAT_PROMPT,
  PRE_ENGLISH_CHAT_PROMPT,
  PRE_SUBMISSION_CHAT_PROMPT,
  PRE_MERGE_RECOVERY_CHAT_PROMPT,
  PRE_DELIVERY_CHAT_PROMPT,
  PRE_DISABLE_CHAT_PROMPT,
} from "./prompts.js";

class NativeToolClient implements AgentClient {
  readonly provider = "codex";
  readonly inner = createTestAgentClients({ supportsMcpServers: true }).codex;
  readonly capabilities = { ...this.inner.capabilities, supportsNativePaseoTools: true };
  readonly catalogs = new Map<string, PaseoToolCatalog>();
  readonly configs = new Map<string, AgentSessionConfig>();
  readonly workerResults: unknown[] = [];
  readonly reviewResults: unknown[] = [];
  readonly prompts: { agentId: string; text: string }[] = [];
  constructor(private readonly reviewIndependently = false) {}
  isAvailable() {
    return this.inner.isAvailable();
  }
  async fetchCatalog(...args: Parameters<AgentClient["fetchCatalog"]>) {
    const catalog = await this.inner.fetchCatalog(...args);
    return { ...catalog, modes: getAgentProviderDefinition(this.provider)!.modes };
  }
  private capture(config: AgentSessionConfig, context?: AgentLaunchContext) {
    if (!context?.agentId || !context.paseoTools) throw new Error("Missing native tool catalog");
    this.catalogs.set(context.agentId, context.paseoTools);
    this.configs.set(context.agentId, config);
  }
  createSession(config: AgentSessionConfig, context?: AgentLaunchContext) {
    if (!config.internal) this.capture(config, context);
    const responder = createTestAgentClients({
      supportsMcpServers: true,
      onStartTurn: (prompt) => {
        const text =
          typeof prompt === "string"
            ? prompt
            : prompt
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
        const operation = readCollaborationPrompt(text);
        this.prompts.push({ agentId: context!.agentId!, text });
        if (operation?.stage === "final" && this.reviewIndependently) {
          const start = text.indexOf("\n\n{") + 2;
          const end = text.indexOf("\n\nCurrent operationId=", start);
          const reviewContext = z
            .object({ evidence: z.object({ id: z.string() }) })
            .parse(JSON.parse(text.slice(start, end)));
          void context!
            .paseoTools!.executeTool("submit_review", {
              operationId: operation.operationId,
              payload: {
                decision: "approved",
                artifactId: reviewContext.evidence.id,
                summary: "Independent review",
                criteria: operation.acceptance.map((criterion) => ({
                  criterion,
                  passed: true,
                  evidence: "Inspected current artifact",
                })),
                findings: [],
              },
            })
            .then(
              (value) => {
                this.reviewResults.push(value);
                return;
              },
              (error) => {
                this.reviewResults.push(error);
                return;
              },
            );
        }
        if (operation?.stage === "execute") {
          void context!
            .paseoTools!.executeTool("submit_result", {
              operationId: operation.operationId,
              payload: result,
            })
            .then(
              (value) => {
                this.workerResults.push(value);
                return;
              },
              (error) => {
                this.workerResults.push(error);
                return;
              },
            );
        }
      },
    }).codex;
    return responder.createSession(config, context);
  }
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    context?: AgentLaunchContext,
  ) {
    if (overrides?.cwd)
      this.capture({ provider: this.provider, ...overrides, cwd: overrides.cwd }, context);
    return this.inner.resumeSession(handle, overrides, context);
  }
}
const exec = promisify(execFile);

test.for(["full", "execute_review"] as const)(
  "native collaboration (%s) keeps the main conversation, dispatches child agents, and waits for human acceptance",
  async (mode, t) => {
    const repo = await mkdtemp(join(tmpdir(), "collaboration-native-"));
    t.onTestFinished(() => rm(repo, { recursive: true, force: true }));
    await exec("git", ["init", repo]);
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: repo },
    );
    const provider = new NativeToolClient(mode === "execute_review");
    const daemon = await createTestPaseoDaemon({ agentClients: { codex: provider } });
    t.onTestFinished(() => daemon.close());
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    t.onTestFinished(() => client.close());
    await client.connect();
    expect(await client.collaborationCommand("status")).toEqual({
      settings: null,
      rolePrompts: {},
      conversations: [],
      error: null,
    });
    const settings = SettingsSchema.parse({
      profiles: [
        {
          id: "native",
          label: "Native Codex",
          provider: "codex/gpt-5.4-mini",
          modeId: "auto",
          transport: "mcp",
        },
      ],
      directorProfileId: "native",
      workerProfileId: "native",
      reviewerProfileId: mode === "execute_review" ? "native" : undefined,
      requirePlanApproval: mode === "execute_review",
    });
    await client.collaborationCommand("settings.save", { settings, base: null });
    await expect(
      client.collaborationCommand("settings.save", {
        settings: { ...settings, maxReworks: 3 },
        base: null,
      }),
    ).rejects.toThrow();
    const main = await client.createAgent({
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: repo,
      title: "Existing main",
      modeId: "auto",
    });
    const streamedNotices = new Set<string>();
    const unsubscribe = daemon.daemon.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream" || event.agentId !== main.id) return;
        if (event.event.type !== "timeline" || event.event.item.type !== "user_message") return;
        const id = event.event.item.clientMessageId;
        if (id?.startsWith("chat-notice:")) streamedNotices.add(id);
      },
      { agentId: main.id, replayState: false },
    );
    t.onTestFinished(unsubscribe);
    const opened = await client.collaborationCommand("conversation.open", {
      mode,
      requestId: "native-test",
      workspaceId: main.workspaceId,
      agentId: main.id,
      goal: "请实施功能",
    });
    expect(opened.conversations.map((c) => c.agentId)).toEqual([main.id]);
    expect(opened.conversations[0].mode).toBe(mode);
    const repeated = await client.collaborationCommand("conversation.open", {
      mode,
      requestId: "native-test",
      workspaceId: main.workspaceId,
      agentId: main.id,
      goal: "请实施功能",
    });
    expect(repeated.conversations.map((c) => c.id)).toEqual(opened.conversations.map((c) => c.id));
    const tools = provider.catalogs.get(main.id)!;
    const status = await tools.executeTool("get_conversation_status", {});
    expect(status.isError).not.toBe(true);
    const chatStatus = JSON.parse(status.content[0].text!);
    expect(chatStatus.latestUserMessage.text).toContain("请实施功能");
    expect(
      await tools.executeTool("start_task", {
        sourceMessageId: chatStatus.latestUserMessage.id,
        goal: "实现功能",
      }),
    ).not.toHaveProperty("isError", true);
    const reader = new Store(join(daemon.paseoHome, "director", "director.sqlite"), false);
    t.onTestFinished(() => reader.close());
    const current = () => reader.all()[0];
    if (mode === "full") {
      await expect
        .poll(() => current()?.operations.find((op) => op.kind === "plan")?.state, {
          timeout: 15000,
        })
        .toBe("sent");
      const planning = current().operations.at(-1)!;
      expect(planning.agentId).toBe(main.id);
      await tools.executeTool("submit_operation", { operationId: planning.id, payload: plan });
    }
    await expect
      .poll(() => current()?.operations.find((op) => op.kind === "execute")?.state, {
        timeout: 15000,
      })
      .toBe("done");
    const execution = current().operations.find((op) => op.kind === "execute")!;
    const child = daemon.daemon.agentManager.getAgent(execution.agentId!)!;
    expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(main.id);
    expect(child.workspaceId).toBe(main.workspaceId);
    expect(provider.configs.get(child.id)?.modeId).toBe("full-access");
    expect(daemon.daemon.agentManager.getAgent(main.id)!.currentModeId).toBe("auto");
    expect(provider.configs.get(child.id)?.model).toBe("gpt-5.4-mini");
    expect(provider.configs.get(child.id)?.mcpServers?.director).toBeUndefined();
    expect(provider.workerResults).toHaveLength(1);
    expect(provider.workerResults[0]).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ accepted: true }) }],
    });
    if (mode === "execute_review") {
      await expect
        .poll(() => current()?.operations.find((op) => op.kind === "final")?.state, {
          timeout: 15000,
        })
        .toBe("done");
      const final = current().operations.at(-1)!;
      expect(current().operations.map((op) => op.kind)).toEqual(["execute", "final"]);
      expect(final.agentId).not.toBe(execution.agentId);
      expect(final.agentId).not.toBe(main.id);
      expect(provider.configs.get(final.agentId!)?.modeId).toBe("full-access");
      expect(
        daemon.daemon.agentManager.getAgent(final.agentId!)!.labels[PARENT_AGENT_ID_LABEL],
      ).toBe(main.id);
      expect(provider.reviewResults).toEqual([
        { content: [{ type: "text", text: JSON.stringify({ accepted: true }) }] },
      ]);
    } else {
      await expect
        .poll(() => current()?.operations.find((op) => op.kind === "final")?.state, {
          timeout: 15000,
        })
        .toBe("sent");
      const final = current().operations.at(-1)!;
      expect(
        await tools.executeTool("submit_operation", {
          operationId: final.id,
          payload: {
            decision: "approved",
            artifactId: current().finalEvidence!.id,
            summary: "Checked repository",
            criteria: finalAcceptance(current().plan!).map((criterion) => ({
              criterion,
              passed: true,
              evidence: "Inspected current artifact",
            })),
            findings: [],
          },
        }),
      ).not.toHaveProperty("isError", true);
    }
    await expect.poll(() => current().phase, { timeout: 15000 }).toBe("awaiting_acceptance");
    expect(current().userAcceptance).toBeUndefined();
    await expect
      .poll(() => reader.conversations()[0].confirmation?.kind, { timeout: 15000 })
      .toBe("final");
    const confirmation = reader.conversations()[0].confirmation!;
    await expect
      .poll(
        () =>
          reader.conversations()[0].notices.find((notice) => notice.id === confirmation.noticeId)
            ?.state,
        { timeout: 15000 },
      )
      .toBe("sent");
    await expect.poll(() => daemon.daemon.agentManager.hasInFlightRun(main.id)).toBe(false);
    const progress = reader
      .conversations()[0]
      .notices.filter((notice) => notice.delivery === "timeline" && notice.state === "sent");
    expect(progress.length).toBeGreaterThan(0);
    const timeline = await daemon.daemon.agentManager.getTimelineRows(main.id);
    for (const notice of progress) {
      expect(readCollaborationNotice(notice.id, notice.text)).toBeDefined();
      expect(streamedNotices.has(notice.id)).toBe(true);
      expect(
        timeline.filter(
          ({ item }) => item.type === "user_message" && item.clientMessageId === notice.id,
        ),
      ).toHaveLength(1);
      expect(provider.prompts.some((prompt) => prompt.text.includes(notice.id))).toBe(false);
    }
    expect(provider.prompts.some((prompt) => prompt.text.includes(confirmation.noticeId))).toBe(
      true,
    );
    await client.sendMessage(main.id, "验收通过", { messageId: "accept-native-result" });
    expect(
      await tools.executeTool("control_task", {
        sourceMessageId: "accept-native-result",
        action: "accept_final",
        confirmationKey: confirmation.key,
      }),
    ).not.toHaveProperty("isError", true);
    expect(current().phase).toBe("completed");
    expect(current().userAcceptance?.decision).toBe("approved");
    if (mode === "full") {
      const target = join(daemon.paseoHome, "target-checkout");
      await exec("git", ["worktree", "add", target, current().sourceBranch!], { cwd: repo });
      await writeFile(join(target, "personal.txt"), "Preserve user work\n");
      await client.sendMessage(main.id, "合并成果", { messageId: "merge-recovery-request" });
      const failed = await tools.executeTool("merge_result", {
        sourceMessageId: "merge-recovery-request",
      });
      expect(failed.isError).toBe(true);
      expect(current().delivery?.status).toBe("failed");
      const prepared = await tools.executeTool("prepare_merge_recovery", {
        sourceMessageId: "merge-recovery-request",
      });
      expect(prepared.isError).not.toBe(true);
      const repair = JSON.parse(prepared.content[0].text!);
      expect(repair.targetCwd).toBe(await realpath(target));
      expect(repair.branch).toBe(current().branch);
      expect(repair.targetStatus).toContain("personal.txt");
      await exec("git", ["stash", "push", "--include-untracked", "-m", "merge recovery"], {
        cwd: target,
      });
      const stash = (await exec("git", ["rev-parse", "refs/stash"], { cwd: target })).stdout.trim();
      const finished = await tools.executeTool("finish_merge_recovery", {
        sourceMessageId: "merge-recovery-request",
        summary: "Isolated target edits for delivery; restoring them afterward",
      });
      expect(finished.isError).not.toBe(true);
      expect(JSON.parse(finished.content[0].text!).status).toBe("merged");
      await exec("git", ["stash", "apply", "--index", stash], { cwd: target });
      expect(await readFile(join(target, "personal.txt"), "utf8")).toBe("Preserve user work\n");
    }
    await expect.poll(() => daemon.daemon.agentManager.hasInFlightRun(main.id)).toBe(false);
    await daemon.daemon.agentManager.reloadAgentSession(main.id, undefined, {
      rehydrateFromDisk: true,
    });
    await daemon.daemon.agentManager.hydrateTimelineFromProvider(main.id);
    const replay = await daemon.daemon.agentManager.getTimelineRows(main.id);
    for (const notice of progress)
      expect(
        replay.filter(
          ({ item }) => item.type === "user_message" && item.clientMessageId === notice.id,
        ),
      ).toHaveLength(1);
  },
  60000,
);

test("conversation.disable exits collaboration, keeps history, and refuses late tools", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "collaboration-disable-"));
  t.onTestFinished(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", repo]);
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repo },
  );
  const provider = new NativeToolClient();
  const daemon = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  t.onTestFinished(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  t.onTestFinished(() => client.close());
  await client.connect();
  const settings = SettingsSchema.parse({
    profiles: [
      {
        id: "native",
        label: "Native Codex",
        provider: "codex/gpt-5.4-mini",
        modeId: "auto",
        transport: "mcp",
      },
    ],
    directorProfileId: "native",
    workerProfileId: "native",
  });
  await client.collaborationCommand("settings.save", { settings, base: null });
  const main = await client.createAgent({
    provider: "codex",
    model: "gpt-5.4-mini",
    cwd: repo,
    title: "Existing main",
    modeId: "auto",
  });
  const opened = await client.collaborationCommand("conversation.open", {
    requestId: "disable-test",
    workspaceId: main.workspaceId,
    agentId: main.id,
    goal: "请实施功能",
  });
  const conversation = opened.conversations[0];
  expect(conversation.disabledAt).toBeUndefined();
  const tools = provider.catalogs.get(main.id)!;
  const status = await tools.executeTool("get_conversation_status", {});
  expect(status).not.toHaveProperty("isError", true);
  const chatStatus = JSON.parse(status.content[0].text!);
  expect(
    await tools.executeTool("start_task", {
      sourceMessageId: chatStatus.latestUserMessage.id,
      goal: "实现功能",
    }),
  ).not.toHaveProperty("isError", true);
  await expect(
    client.collaborationCommand("conversation.disable", {
      id: conversation.id,
      cancelRunning: false,
    }),
  ).rejects.toThrow("确认停止");
  const stillActive = (await client.collaborationCommand("status")).conversations.find(
    (entry) => entry.id === conversation.id,
  )!;
  expect(stillActive.disabledAt).toBeUndefined();
  expect(stillActive.run?.control).not.toBe("canceled");
  const disabled = await client.collaborationCommand("conversation.disable", {
    id: conversation.id,
    cancelRunning: true,
  });
  const closed = disabled.conversations.find((entry) => entry.id === conversation.id)!;
  expect(closed.disabledAt).toBeGreaterThan(0);
  expect(closed.run?.control).toBe("canceled");
  // The main chat is released back to a normal session: its collaboration identity is gone.
  expect(
    daemon.daemon.agentManager.getAgent(main.id)!.labels["director-conversation"],
  ).toBeUndefined();
  // The chat tool refuses after exit; the record stays in status for history.
  expect(await tools.executeTool("get_conversation_status", {})).toHaveProperty("isError", true);
  const again = await client.collaborationCommand("conversation.open", {
    requestId: "disable-test-2",
    workspaceId: main.workspaceId,
    agentId: main.id,
    goal: "再次启用",
  });
  const reopened = again.conversations.find((entry) => entry.requestId === "disable-test-2")!;
  expect(reopened.id).not.toBe(conversation.id);
  expect(reopened.disabledAt).toBeUndefined();
  expect((await client.collaborationCommand("status")).conversations).toHaveLength(2);
});

test.for([
  {
    name: "current",
    prompt: CHAT_PROMPT,
  },
  { name: "before-english-prompts", prompt: PRE_ENGLISH_CHAT_PROMPT },
  { name: "before-submission-scope", prompt: PRE_SUBMISSION_CHAT_PROMPT },
  { name: "before-merge-recovery", prompt: PRE_MERGE_RECOVERY_CHAT_PROMPT },
  {
    name: "before-delivery",
    prompt: PRE_DELIVERY_CHAT_PROMPT,
  },
  {
    name: "before-exit",
    prompt: PRE_DISABLE_CHAT_PROMPT,
  },
])(
  "exiting a Paseo-created collaboration restores the $name prompt and keeps the chat normal",
  async ({ prompt }, t) => {
    const repo = await mkdtemp(join(tmpdir(), "collaboration-created-"));
    t.onTestFinished(() => rm(repo, { recursive: true, force: true }));
    await exec("git", ["init", repo]);
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: repo },
    );
    const provider = new NativeToolClient();
    const daemon = await createTestPaseoDaemon({ agentClients: { codex: provider } });
    t.onTestFinished(() => daemon.close());
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    t.onTestFinished(() => client.close());
    await client.connect();
    const settings = SettingsSchema.parse({
      profiles: [
        {
          id: "native",
          label: "Native Codex",
          provider: "codex/gpt-5.4-mini",
          modeId: "auto",
          transport: "mcp",
          instructions: "只回答问题，不要改代码",
        },
      ],
      directorProfileId: "native",
      workerProfileId: "native",
    });
    await client.collaborationCommand("settings.save", { settings, base: null });
    const seed = await client.createAgent({
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: repo,
      title: "seed",
    });
    const opened = await client.collaborationCommand("conversation.open", {
      requestId: "created-disable",
      workspaceId: seed.workspaceId,
      goal: "请实施功能",
    });
    const conversation = opened.conversations[0];
    const mainId = conversation.agentId!;
    // A Paseo-created main agent starts with the collaboration prompt as its system prompt.
    expect(daemon.daemon.agentManager.getAgent(mainId)!.config.systemPrompt).toContain(
      "get_conversation_status",
    );
    const originalPrompt = daemon.daemon.agentManager.getAgent(mainId)!.config.systemPrompt!;
    await daemon.daemon.agentManager.setAgentSystemPrompt(
      mainId,
      prompt + originalPrompt.slice(CHAT_PROMPT.length),
    );
    await client.collaborationCommand("conversation.disable", { id: conversation.id });
    const released = daemon.daemon.agentManager.getAgent(mainId)!;
    expect(released.labels["director-conversation"]).toBeUndefined();
    // Only the collaboration prefix is stripped; the user's own instructions survive exactly.
    expect(released.config.systemPrompt).toBe(
      "Additional user requirements:\n只回答问题，不要改代码",
    );
    // A normal message is an ordinary chat: no collaboration task is created.
    const reader = new Store(join(daemon.paseoHome, "director", "director.sqlite"), false);
    t.onTestFinished(() => reader.close());
    await client.sendMessage(mainId, "你好", { messageId: "after-exit" });
    await expect.poll(() => daemon.daemon.agentManager.hasInFlightRun(mainId)).toBe(false);
    expect(reader.all()).toHaveLength(0);
    // The same workspace can be re-enabled later under a new request.
    const again = await client.collaborationCommand("conversation.open", {
      requestId: "created-disable-2",
      workspaceId: seed.workspaceId,
      goal: "再次启用",
    });
    expect(again.conversations).toHaveLength(2);
    expect(
      again.conversations.find((entry) => entry.requestId === "created-disable-2")!.disabledAt,
    ).toBeUndefined();
  },
);

test("exiting releases labels on an archived main chat without loading it", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "collaboration-archived-"));
  t.onTestFinished(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", repo]);
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repo },
  );
  const provider = new NativeToolClient();
  const daemon = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  t.onTestFinished(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  t.onTestFinished(() => client.close());
  await client.connect();
  const settings = SettingsSchema.parse({
    profiles: [
      {
        id: "native",
        label: "Native Codex",
        provider: "codex/gpt-5.4-mini",
        modeId: "auto",
        transport: "mcp",
      },
    ],
    directorProfileId: "native",
    workerProfileId: "native",
  });
  await client.collaborationCommand("settings.save", { settings, base: null });
  const seed = await client.createAgent({
    provider: "codex",
    model: "gpt-5.4-mini",
    cwd: repo,
    title: "seed",
  });
  const opened = await client.collaborationCommand("conversation.open", {
    requestId: "archived-disable",
    workspaceId: seed.workspaceId,
    goal: "请实施功能",
  });
  const conversation = opened.conversations[0];
  const mainId = conversation.agentId!;
  // Complete the main chat's tool handshake before archiving: with toolsConnectedAt set the
  // background tick skips its handshake probe instead of loading the archived session.
  const tools = provider.catalogs.get(mainId)!;
  expect(await tools.executeTool("get_conversation_status", {})).not.toHaveProperty(
    "isError",
    true,
  );
  await client.archiveAgent(mainId);
  await client.collaborationCommand("conversation.disable", { id: conversation.id });
  // The exit released the stored labels without loading the archived session: the manager holds no
  // live session for it (a retained snapshot would be closed, never live), and the record stays
  // archived in storage.
  await expect
    .poll(() => {
      const snapshot = daemon.daemon.agentManager.getAgent(mainId);
      return snapshot === null || snapshot.lifecycle === "closed";
    })
    .toBe(true);
  await daemon.daemon.agentManager.flush();
  const storage = new AgentStorage(join(daemon.paseoHome, "agents"), createTestLogger());
  const record = await storage.get(mainId);
  expect(record?.archivedAt).toBeDefined();
  expect(record?.labels["director-conversation"]).toBeUndefined();
});

test("inline collaboration models use task defaults and prompts saved without agent profiles", async (t) => {
  const provider = new NativeToolClient();
  const daemon = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  t.onTestFinished(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  t.onTestFinished(() => client.close());
  await client.connect();
  const prompts = { execute: "Read the project docs first" };
  const saved = await client.collaborationCommand("prompts.save", { prompts, base: {} });
  expect(saved.settings).toBeNull();
  expect(saved.rolePrompts).toEqual(prompts);
  await expect(
    client.collaborationCommand("prompts.save", { prompts: {}, base: {} }),
  ).rejects.toThrow();
  const main = await client.createAgent({
    provider: "codex",
    model: "gpt-5.4-mini",
    cwd: daemon.paseoHome,
  });
  const settings = SettingsSchema.parse({
    profiles: [{ id: "worker", label: "Codex", provider: "codex/gpt-5.4-mini", transport: "mcp" }],
    directorProfileId: "worker",
    workerProfileId: "worker",
    reviewerProfileId: "worker",
  });
  const opened = await client.collaborationCommand("conversation.open", {
    requestId: "inline-models",
    workspaceId: main.workspaceId,
    agentId: main.id,
    mode: "execute_review",
    settings,
  });
  expect(opened.conversations[0].settings?.rolePrompts).toEqual(prompts);
  expect(opened.conversations[0].settings?.maxReworks).toBe(2);
  expect(opened.settings).toBeNull();
  await client.collaborationCommand("prompts.save", {
    prompts: { execute: "New prompt" },
    base: prompts,
  });
  const repeated = await client.collaborationCommand("conversation.open", {
    requestId: "inline-models",
    workspaceId: main.workspaceId,
    agentId: main.id,
    mode: "execute_review",
    settings: { ...settings, maxReworks: 9 },
  });
  expect(repeated.conversations[0].settings).toEqual(opened.conversations[0].settings);
});
