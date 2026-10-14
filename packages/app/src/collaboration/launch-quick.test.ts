import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { SettingsSchema, type Settings } from "@getpaseo/protocol/collaboration/schema";
import {
  buildModelSelection,
  collectFallbackIssues,
  openCollaborationLaunch,
  type LaunchPreferences,
  type LaunchSnapshot,
  type ModelSelection,
} from "./launch-model";
import {
  canStartCollaboration,
  resolveQuickLaunch,
  settingsUseExecutionHandoff,
  type QuickLaunch,
  type QuickLaunchCapabilities,
} from "./launch-quick";

const providers: ProviderSnapshotEntry[] = [
  {
    provider: "codex",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "codex",
        id: "gpt-5",
        label: "GPT-5",
        isSelectable: true,
        thinkingOptions: [{ id: "high", label: "High" }],
      },
      { provider: "codex", id: "gpt-5-mini", label: "GPT-5 mini" },
    ],
  },
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    models: [{ provider: "claude", id: "opus", label: "Opus", isSelectable: true }],
  },
];

const capabilities: QuickLaunchCapabilities = {
  unified: true,
  worktree: true,
  executionHandoff: true,
};

function selection(provider: string, model: string, thinkingOptionId?: string): ModelSelection {
  return buildModelSelection(provider, model, thinkingOptionId);
}

function preferences(overrides: Partial<LaunchPreferences> = {}): LaunchPreferences {
  return {
    mode: "execute_review",
    isolation: "local",
    selections: {
      director: null,
      worker: selection("codex", "gpt-5", "high"),
      reviewer: selection("claude", "opus"),
    },
    maxReworks: 2,
    runTimeoutMs: 4 * 3_600_000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<LaunchSnapshot> = {}): LaunchSnapshot {
  return { ready: true, settings: null, currentAgent: true, ...overrides };
}

function savedSettings(): Settings {
  return SettingsSchema.parse({
    profiles: [
      { id: "worker", label: "Worker", provider: "codex/gpt-5" },
      { id: "reviewer", label: "Reviewer", provider: "claude/opus" },
    ],
    directorProfileId: "worker",
    workerProfileId: "worker",
    reviewerProfileId: "reviewer",
  });
}

/** Throws rather than returning, so a wrong discriminant fails the assertion it follows. */
function expectStart(decision: QuickLaunch): Extract<QuickLaunch, { kind: "start" }> {
  if (decision.kind !== "start") throw new Error(`expected a quick start, got ${decision.kind}`);
  return decision;
}

describe("resolveQuickLaunch", () => {
  it("starts from a remembered setup while it is still valid", () => {
    const decision = expectStart(
      resolveQuickLaunch({
        snapshot: snapshot(),
        remembered: preferences(),
        providers,
        capabilities,
      }),
    );
    expect(decision.resolution).toEqual({
      mode: "execute_review",
      isolation: "local",
      settings: {
        profiles: [
          {
            id: "worker",
            label: "gpt-5",
            provider: "codex/gpt-5",
            thinkingOptionId: "high",
            transport: "mcp",
          },
          { id: "reviewer", label: "opus", provider: "claude/opus", transport: "mcp" },
        ],
        directorProfileId: "reviewer",
        workerProfileId: "worker",
        reviewerProfileId: "reviewer",
        reviewerAsLead: true,
        categoryOverrides: {},
        taskOverrides: {},
        allowDirectorSelection: false,
        maxReworks: 2,
        maxAttempts: 40,
        turnTimeoutMs: 1800000,
        runTimeoutMs: 4 * 3_600_000,
        requirePlanApproval: false,
        verificationCommands: [],
      },
    });
  });

  it("opens the form on the first task, with nothing remembered", () => {
    expect(resolveQuickLaunch({ snapshot: snapshot(), providers, capabilities })).toEqual({
      kind: "configure",
    });
  });

  it("opens the form on a first task even when the inherited model resolves", () => {
    // Without the first-task guard, the inherited worker model alone would start a partial workflow.
    const decision = resolveQuickLaunch({
      snapshot: snapshot({ currentModel: selection("codex", "gpt-5", "high") }),
      providers,
      capabilities,
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("opens the form when the remembered model is gone", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences({
        selections: {
          director: null,
          worker: selection("codex", "removed"),
          reviewer: selection("claude", "opus"),
        },
      }),
      providers,
      capabilities,
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("opens the form when the remembered thinking option is gone", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences({
        selections: {
          director: null,
          worker: selection("codex", "gpt-5", "ultra"),
          reviewer: selection("claude", "opus"),
        },
      }),
      providers,
      capabilities,
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("opens the form when execution + review has no reviewer", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences({
        selections: { director: null, worker: selection("codex", "gpt-5"), reviewer: null },
      }),
      providers,
      capabilities,
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("opens the form when the host cannot run reviewer-led collaboration", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences(),
      providers,
      capabilities: { ...capabilities, unified: false },
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("opens the form when the host cannot run a worktree", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences({ isolation: "worktree" }),
      providers,
      capabilities: { ...capabilities, worktree: false },
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("reuses the conversation's saved setup without resending settings", () => {
    const decision = expectStart(
      resolveQuickLaunch({
        snapshot: snapshot({
          conversation: {
            id: "chat-1",
            workspaceId: "ws-1",
            agentId: "agent-1",
            title: "Conversation",
            mode: "full",
          },
        }),
        remembered: preferences(),
        providers,
        capabilities,
      }),
    );
    expect(decision.resolution).toEqual({
      mode: "full",
      isolation: "local",
      settings: undefined,
    });
  });

  it("keeps a started run's mode even when the remembered setup differs", () => {
    const decision = expectStart(
      resolveQuickLaunch({
        snapshot: snapshot({
          conversation: {
            id: "chat-1",
            workspaceId: "ws-1",
            agentId: "agent-1",
            title: "Conversation",
            mode: "execute_review",
            settings: savedSettings(),
            run: {
              id: "run-1",
              phase: "executing",
              control: "running",
              message: "",
              done: 0,
              total: 1,
            },
          },
        }),
        remembered: preferences({ mode: "full" }),
        providers,
        capabilities,
      }),
    );
    expect(decision.resolution.mode).toBe("execute_review");
    expect(decision.resolution.settings).toBeUndefined();
  });
});

describe("openCollaborationLaunch model inheritance", () => {
  it("seeds the first task's execution model from the conversation", () => {
    const model = openCollaborationLaunch(
      snapshot({ currentModel: selection("codex", "gpt-5", "high") }),
    );
    model.applyProviders(providers);
    expect(model.getState().selections).toEqual({
      director: null,
      worker: {
        provider: "codex",
        model: "gpt-5",
        providerLabel: "codex",
        modelLabel: "gpt-5",
        thinkingOptionId: "high",
        thinkingOptionLabel: "High",
      },
      reviewer: null,
    });
    model.close();
  });

  it("does not inherit when a remembered setup already exists", () => {
    const model = openCollaborationLaunch(
      snapshot({ currentModel: selection("codex", "gpt-5-mini") }),
      undefined,
      undefined,
      undefined,
      preferences(),
    );
    model.applyProviders(providers);
    expect(model.getState().selections.worker?.model).toBe("gpt-5");
    model.close();
  });

  it("cannot resolve before a reviewer is chosen in execution + review", () => {
    const model = openCollaborationLaunch(
      snapshot({ currentModel: selection("codex", "gpt-5", "high") }),
      "execute_review",
    );
    model.applyProviders(providers);
    expect(model.resolve()).toBeNull();
    model.close();
  });
});

describe("execution fallbacks", () => {
  function readyModel(fallbacks?: ModelSelection[]) {
    const model = openCollaborationLaunch(
      snapshot(),
      "execute_review",
      {
        director: null,
        worker: selection("codex", "gpt-5", "high"),
        reviewer: selection("claude", "opus"),
      },
      undefined,
      undefined,
      fallbacks,
    );
    model.applyProviders(providers);
    return model;
  }

  it("omits an empty list and sends the order the user arranged", () => {
    const model = readyModel();
    expect(model.resolve()?.settings).not.toHaveProperty("executionFallbacks");
    expect(model.preferences().fallbacks).toBeUndefined();
    model.addFallback();
    expect(model.getState().fallbackIssues.map((issue) => issue.code)).toContain("incomplete");
    expect(model.resolve()).toBeNull();
    model.selectFallbackProvider(0, "claude", "Claude");
    model.selectFallbackModel(0, "opus", "Opus");
    model.addFallback();
    model.selectFallbackProvider(1, "codex", "Codex");
    model.selectFallbackModel(1, "gpt-5-mini", "GPT-5 mini");
    model.moveFallback(1, -1);
    expect(model.resolve()?.settings?.executionFallbacks).toEqual({
      worker: [{ provider: "codex/gpt-5-mini" }, { provider: "claude/opus" }],
    });
    expect(model.preferences().fallbacks?.map((item) => item.model)).toEqual([
      "gpt-5-mini",
      "opus",
    ]);
    model.removeFallback(0);
    model.removeFallback(0);
    expect(model.resolve()?.settings).not.toHaveProperty("executionFallbacks");
    expect(model.preferences().fallbacks).toBeUndefined();
    model.close();
  });

  it("blocks a duplicate, the execution model, a missing model, and a stale thinking level", () => {
    const same = readyModel([selection("codex", "gpt-5", "high")]);
    expect(same.getState().fallbackIssues.map((issue) => issue.code)).toContain("same");
    expect(same.resolve()).toBeNull();
    same.close();

    const duplicate = readyModel([selection("claude", "opus"), selection("claude", "opus")]);
    expect(duplicate.getState().fallbackIssues.map((issue) => issue.code)).toContain("duplicate");
    expect(duplicate.resolve()).toBeNull();
    duplicate.close();

    const missing = readyModel([selection("codex", "removed")]);
    expect(missing.getState().fallbackIssues.map((issue) => issue.code)).toContain("unavailable");
    expect(missing.resolve()).toBeNull();
    missing.close();

    const thinking = readyModel([
      {
        provider: "codex",
        model: "gpt-5-mini",
        providerLabel: "codex",
        modelLabel: "mini",
        thinkingOptionId: "ultra",
        thinkingOptionLabel: "Ultra",
      },
    ]);
    expect(thinking.getState().fallbackIssues.map((issue) => issue.code)).toContain("thinking");
    expect(thinking.resolve()).toBeNull();
    thinking.close();
  });

  it("keeps an explicit empty list instead of restoring remembered backups", () => {
    const model = openCollaborationLaunch(
      snapshot(),
      undefined,
      undefined,
      undefined,
      preferences({ fallbacks: [selection("claude", "opus")] }),
      [],
    );
    expect(model.getState().fallbacks).toEqual([]);
    model.close();
  });

  it("keeps saved backups on an existing conversation without resending settings", () => {
    const settings = SettingsSchema.parse({
      ...savedSettings(),
      executionFallbacks: { worker: [{ provider: "codex/gpt-5-mini" }] },
    });
    const model = openCollaborationLaunch(
      snapshot({
        conversation: {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Conversation",
          mode: "execute_review",
          settings,
        },
      }),
    );
    model.applyProviders(providers);
    expect(model.getState().agentsLocked).toBe(true);
    expect(model.getState().fallbacks.map((item) => item.model)).toEqual(["gpt-5-mini"]);
    model.removeFallback(0);
    model.moveFallback(0, -1);
    expect(model.getState().fallbacks).toHaveLength(1);
    expect(model.resolve()?.settings).toBeUndefined();
    model.close();
  });

  it("reports the backup limit without treating an unloaded catalog as unavailable", () => {
    const many = Array.from({ length: 9 }, (_, index) => selection("claude", `extra-${index}`));
    const issues = collectFallbackIssues(many, selection("codex", "gpt-5"), () => "unknown");
    expect(issues.map((issue) => issue.code)).toContain("limit");
    expect(issues.map((issue) => issue.code)).not.toContain("unavailable");
  });

  it("opens the form when backups need a handoff the host does not offer", () => {
    const remembered = preferences({ fallbacks: [selection("codex", "gpt-5-mini")] });
    expect(
      resolveQuickLaunch({
        snapshot: snapshot(),
        remembered,
        providers,
        capabilities: { ...capabilities, executionHandoff: false },
      }),
    ).toEqual({ kind: "configure" });
    const started = expectStart(
      resolveQuickLaunch({
        snapshot: snapshot(),
        remembered,
        providers,
        capabilities,
      }),
    );
    expect(started.resolution.settings?.executionFallbacks).toEqual({
      worker: [{ provider: "codex/gpt-5-mini" }],
    });
  });

  it("opens the form when a remembered backup thinking level is gone", () => {
    expect(
      resolveQuickLaunch({
        snapshot: snapshot(),
        remembered: preferences({
          fallbacks: [
            {
              provider: "codex",
              model: "gpt-5-mini",
              providerLabel: "codex",
              modelLabel: "mini",
              thinkingOptionId: "ultra",
              thinkingOptionLabel: "Ultra",
            },
          ],
        }),
        providers,
        capabilities,
      }),
    ).toEqual({ kind: "configure" });
  });

  it("refuses to start a new task that still has backups on an old host", () => {
    const base = {
      ready: true,
      canContinue: true,
      isolation: "local" as const,
      supportsWorktree: true,
      agentsLocked: false,
      fallbackCount: 1,
      supportsHandoff: true as boolean | null,
    };
    expect(canStartCollaboration(base)).toBe(true);
    expect(canStartCollaboration({ ...base, supportsHandoff: false })).toBe(false);
    expect(canStartCollaboration({ ...base, supportsHandoff: null })).toBe(false);
    expect(canStartCollaboration({ ...base, fallbackCount: 0, supportsHandoff: false })).toBe(true);
    expect(canStartCollaboration({ ...base, agentsLocked: true, supportsHandoff: false })).toBe(
      true,
    );
    expect(settingsUseExecutionHandoff(undefined)).toBe(false);
    expect(settingsUseExecutionHandoff(savedSettings())).toBe(false);
    expect(
      settingsUseExecutionHandoff(
        SettingsSchema.parse({
          ...savedSettings(),
          executionFallbacks: { worker: [{ provider: "codex/gpt-5-mini" }] },
        }),
      ),
    ).toBe(true);
  });
});
