import { test, expect } from "vitest";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { readCollaborationPrompt } from "@getpaseo/protocol/collaboration/presentation";
import { finalAcceptance, SettingsSchema } from "@getpaseo/protocol/collaboration/schema";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSessionConfig,
  AgentPersistenceHandle,
} from "../agent/agent-sdk-types.js";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import { Store } from "./store.js";
import { plan, result } from "./test-utils/harness.js";

class NativeToolClient implements AgentClient {
  readonly provider = "codex";
  readonly inner = createTestAgentClients({ supportsMcpServers: true }).codex;
  readonly capabilities = { ...this.inner.capabilities, supportsNativePaseoTools: true };
  readonly catalogs = new Map<string, PaseoToolCatalog>();
  readonly configs = new Map<string, AgentSessionConfig>();
  readonly workerResults: unknown[] = [];
  readonly reviewResults: unknown[] = [];
  constructor(private readonly reviewIndependently = false) {}
  isAvailable() {
    return this.inner.isAvailable();
  }
  fetchCatalog(...args: Parameters<AgentClient["fetchCatalog"]>) {
    return this.inner.fetchCatalog(...args);
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
        if (operation?.stage === "final" && this.reviewIndependently) {
          const start = text.indexOf("\n\n{") + 2;
          const end = text.indexOf("\n\n本轮 operationId=", start);
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
          modeId: "full-access",
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
      modeId: "full-access",
    });
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
  },
  60000,
);

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
