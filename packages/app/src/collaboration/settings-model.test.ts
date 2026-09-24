import { test, expect } from "vitest";
import { SettingsSchema } from "@getpaseo/protocol/collaboration/schema";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { openCollaborationSettings } from "./settings-model";
import { openCollaborationLaunch, type LaunchRole } from "./launch-model";

const providers: ProviderSnapshotEntry[] = [
  {
    provider: "codex",
    label: "Codex",
    enabled: true,
    status: "ready",
    defaultModeId: "auto-review",
    models: [
      { provider: "codex", id: "model-a", label: "Model A" },
      { provider: "codex", id: "model-b", label: "Model B" },
    ],
  },
  {
    provider: "claude",
    label: "Claude",
    enabled: true,
    status: "ready",
    models: [{ provider: "claude", id: "sonnet", label: "Sonnet" }],
  },
];
function choose(model: ReturnType<typeof openCollaborationLaunch>, role: LaunchRole) {
  model.selectProvider(role, "codex", "Codex");
  model.selectModel(role, "model-a", "Model A");
}

test("new collaboration chooses models without profiles and uses default task settings", async () => {
  const model = openCollaborationLaunch({ settings: null, currentAgent: false }, "execute_review");
  model.applyProviders(providers);
  expect(model.getState().canContinue).toBe(false);
  choose(model, "worker");
  expect(model.getState().canContinue).toBe(false);
  choose(model, "reviewer");
  expect(model.getState().canContinue).toBe(true);
  await model.start(async (mode, settings) => {
    expect(mode).toBe("execute_review");
    expect(settings).toEqual(
      SettingsSchema.parse({
        profiles: ["worker", "reviewer"].map((id) => ({
          id,
          label: "Model A",
          provider: "codex/model-a",
          modeId: "auto-review",
          transport: "mcp",
        })),
        directorProfileId: "worker",
        workerProfileId: "worker",
        reviewerProfileId: "reviewer",
      }),
    );
  });
  model.close();
});

test("changing provider clears its model and catalog refresh preserves explicit selections", () => {
  const model = openCollaborationLaunch({ settings: null, currentAgent: true });
  model.applyProviders(providers);
  choose(model, "worker");
  expect(model.getState().canContinue).toBe(true);
  model.selectProvider("worker", "claude", "Claude");
  expect(model.getState().selections.worker?.model).toBe("");
  expect(model.getState().canContinue).toBe(false);
  model.selectModel("worker", "sonnet", "Chosen Sonnet");
  model.applyProviders([...providers]);
  model.applySnapshot({ settings: null, currentAgent: true });
  expect(model.getState().selections.worker).toEqual({
    provider: "claude",
    providerLabel: "Claude",
    model: "sonnet",
    modelLabel: "Chosen Sonnet",
  });
  expect(model.getState().canContinue).toBe(true);
  model.applyProviders([providers[0]]);
  expect(model.getState().canContinue).toBe(false);
  expect(model.getState().selections.worker?.modelLabel).toBe("Chosen Sonnet");
  model.close();
});

test("full workflow requires a lead for new conversations and preserves selections across modes and settings", () => {
  const model = openCollaborationLaunch({ settings: null, currentAgent: false });
  model.applyProviders(providers);
  choose(model, "worker");
  expect(model.getState().canContinue).toBe(false);
  choose(model, "director");
  expect(model.getState().canContinue).toBe(true);
  model.selectMode("execute_review");
  expect(model.getState().canContinue).toBe(false);
  choose(model, "reviewer");
  const reopened = openCollaborationLaunch(
    { settings: null, currentAgent: false },
    model.getState().mode,
    model.getState().selections,
  );
  reopened.applyProviders(providers);
  expect(reopened.getState().selections).toEqual(model.getState().selections);
  expect(reopened.getState().mode).toBe("execute_review");
  reopened.selectMode("full");
  expect(reopened.getState().canContinue).toBe(true);
  model.close();
  reopened.close();
});

test("launch locks pending edits and duplicate submissions, then retries failures with the selected models", async () => {
  const model = openCollaborationLaunch({ settings: null, currentAgent: true });
  model.applyProviders(providers);
  choose(model, "worker");
  let finish = () => {};
  let starts = 0;
  const pending = model.start(() => {
    starts++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  model.selectProvider("worker", "claude", "Claude");
  model.selectMode("execute_review");
  await model.start(async () => {
    starts++;
  });
  expect(starts).toBe(1);
  expect(model.getState().mode).toBe("full");
  expect(model.getState().selections.worker?.provider).toBe("codex");
  expect(model.getState().canContinue).toBe(false);
  finish();
  await pending;
  await model.start(async () => {
    throw new Error("Connection lost");
  });
  expect(model.getState().error).toBe("Connection lost");
  await model.start(async () => {
    starts++;
  });
  expect(starts).toBe(2);
  expect(model.getState().error).toBe("");
  model.close();
});

test("legacy advanced defaults do not carry into a new task, existing conversations keep saved models", async () => {
  const settings = SettingsSchema.parse({
    profiles: [{ id: "old", label: "Old profile", provider: "codex/model-a" }],
    directorProfileId: "old",
    workerProfileId: "old",
    maxReworks: 9,
    requirePlanApproval: true,
  });
  const model = openCollaborationLaunch({ settings, currentAgent: false });
  model.applyProviders(providers);
  await model.start(async (_mode, next) => {
    expect(next?.maxReworks).toBe(2);
    expect(next?.requirePlanApproval).toBe(false);
  });
  const existing = openCollaborationLaunch({
    settings: null,
    currentAgent: true,
    conversation: {
      id: "chat",
      workspaceId: "workspace",
      title: "Existing",
      settings,
      mode: "full",
      run: {
        id: "run",
        phase: "executing",
        control: "running",
        message: "Working",
        done: 0,
        total: 1,
      },
    },
  });
  existing.selectMode("execute_review");
  existing.selectProvider("worker", "claude", "Claude");
  expect(existing.getState().mode).toBe("full");
  expect(existing.getState().selections.worker?.provider).toBe("codex");
  expect(existing.getState().canContinue).toBe(true);
  await existing.start(async (_mode, next) => {
    expect(next).toBeUndefined();
  });
  model.close();
  existing.close();
});

test("prompts save before choosing any models; conflicts preserve edits and the saved base", async () => {
  const model = openCollaborationSettings({});
  model.setPrompt("execute", "Read docs first");
  await model.save(async () => {
    throw new Error("Conflict");
  });
  expect(model.getState().error).toBe("Conflict");
  expect(model.getState().prompts).toEqual({ execute: "Read docs first" });
  await model.save(async (prompts, base) => {
    expect(base).toEqual({});
    expect(prompts).toEqual({ execute: "Read docs first" });
  });
  expect(model.getState().saved).toBe(true);
  model.setPrompt("review", "Check tests");
  await model.save(async (_prompts, base) => {
    expect(base).toEqual({ execute: "Read docs first" });
  });
  model.close();
});

test("invalid prompts stay editable and successful saves remain committed if returning fails", async () => {
  const model = openCollaborationSettings({});
  model.setPrompt("plan", "a".repeat(8001));
  let writes = 0;
  await model.save(async () => {
    writes++;
  });
  expect(writes).toBe(0);
  expect(model.getState().error).not.toBe("");
  model.setPrompt("plan", "Read docs");
  await model.save(
    async () => {
      writes++;
    },
    async () => {
      throw new Error("Navigation failed");
    },
  );
  expect(model.getState().saved).toBe(true);
  expect(model.getState().error).toBe("Navigation failed");
  await model.save(async (_prompts, base) => {
    expect(base).toEqual({ plan: "Read docs" });
  });
  expect(writes).toBe(1);
  model.close();
});

test("late launch data seeds saved models once without replacing user edits on refresh", () => {
  const model = openCollaborationLaunch({ settings: null, currentAgent: true, ready: false });
  const settings = SettingsSchema.parse({
    profiles: [{ id: "saved", label: "Saved", provider: "codex/model-a" }],
    directorProfileId: "saved",
    workerProfileId: "saved",
  });
  model.applyProviders(providers);
  expect(model.getState().canContinue).toBe(false);
  model.applySnapshot({ settings, currentAgent: true, ready: true });
  expect(model.getState().selections.worker?.model).toBe("model-a");
  model.selectModel("worker", "model-b", "Model B");
  model.applySnapshot({ settings, currentAgent: true, ready: true });
  expect(model.getState().selections.worker?.model).toBe("model-b");
  model.close();
});
