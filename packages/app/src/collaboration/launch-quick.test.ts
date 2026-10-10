import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { SettingsSchema, type Settings } from "@getpaseo/protocol/collaboration/schema";
import {
  buildModelSelection,
  openCollaborationLaunch,
  type LaunchPreferences,
  type LaunchSnapshot,
  type ModelSelection,
} from "./launch-model";
import { resolveQuickLaunch, type QuickLaunch, type QuickLaunchCapabilities } from "./launch-quick";

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
  inlineModels: true,
  executeReview: true,
  worktree: true,
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
        directorProfileId: "worker",
        workerProfileId: "worker",
        reviewerProfileId: "reviewer",
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

  it("opens the form when the host cannot do inline models", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences(),
      providers,
      capabilities: { ...capabilities, inlineModels: false },
    });
    expect(decision).toEqual({ kind: "configure" });
  });

  it("opens the form when the host cannot run execution + review", () => {
    const decision = resolveQuickLaunch({
      snapshot: snapshot(),
      remembered: preferences(),
      providers,
      capabilities: { ...capabilities, executeReview: false },
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
