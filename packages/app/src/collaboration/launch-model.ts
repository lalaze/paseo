import {
  collaborationMode,
  SettingsSchema,
  type CollaborationIsolation,
  type CollaborationMode,
  type Profile,
  type Settings,
} from "@getpaseo/protocol/collaboration/schema";
import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export type LaunchRole = "director" | "worker" | "reviewer";
export interface ModelSelection {
  provider: string;
  model: string;
  providerLabel: string;
  modelLabel: string;
}
export type LaunchSelections = Record<LaunchRole, ModelSelection | null>;
export interface LaunchSnapshot {
  ready?: boolean;
  settings: Settings | null;
  conversation?: CollaborationState["conversations"][number];
  currentAgent: boolean;
}

function seedSelection(profile: Profile | undefined): ModelSelection | null {
  if (!profile) return null;
  const slash = profile.provider.indexOf("/");
  const provider = profile.provider.slice(0, slash);
  const model = profile.provider.slice(slash + 1);
  return { provider, model, providerLabel: provider, modelLabel: model };
}

export function openCollaborationLaunch(
  initial: LaunchSnapshot,
  selected?: CollaborationMode,
  restored?: LaunchSelections,
) {
  let snapshot = initial;
  let mode = selected ?? collaborationMode(initial.conversation ?? {});
  let modeSelected = selected !== undefined;
  let isolation: CollaborationIsolation = initial.conversation?.isolation ?? "local";
  let isolationSelected = false;
  let seeded = initial.ready !== false;
  function seed(settings: Settings | null | undefined): LaunchSelections {
    return {
      director: seedSelection(settings?.profiles.find((p) => p.id === settings.directorProfileId)),
      worker: seedSelection(settings?.profiles.find((p) => p.id === settings.workerProfileId)),
      reviewer: seedSelection(settings?.profiles.find((p) => p.id === settings.reviewerProfileId)),
    };
  }
  let selections = restored ?? seed(initial.conversation?.settings ?? initial.settings);
  let entries: ProviderSnapshotEntry[] = [];
  let pending = false;
  let error = "";
  const listeners = new Set<() => void>();
  function models(provider: string) {
    const entry = entries.find((candidate) => candidate.provider === provider && candidate.enabled);
    return filterSelectableModels(entry?.models ?? null) ?? [];
  }
  function valid(selection: ModelSelection | null) {
    return (
      selection !== null && models(selection.provider).some((model) => model.id === selection.model)
    );
  }
  function read() {
    const locked = Boolean(snapshot.conversation?.run);
    if (locked) {
      mode = collaborationMode(snapshot.conversation!);
      isolation = snapshot.conversation?.isolation ?? "local";
    }
    const agentsLocked = Boolean(snapshot.conversation);
    const showDirector = mode === "full" && !snapshot.currentAgent;
    const directorValid = !showDirector || valid(selections.director);
    const reviewerValid = (mode === "full" && !selections.reviewer) || valid(selections.reviewer);
    const complete = valid(selections.worker) && directorValid && reviewerValid;
    const savedReviewer = snapshot.conversation?.settings?.reviewerProfileId;
    const canReopen = mode === "full" || Boolean(savedReviewer);
    return {
      mode,
      isolation,
      locked,
      agentsLocked,
      showDirector,
      selections,
      pending,
      error,
      canContinue: snapshot.ready !== false && !pending && (agentsLocked ? canReopen : complete),
      providerOptions: entries
        .filter((entry) => entry.enabled)
        .map((entry) => ({
          id: entry.provider,
          value: entry.provider,
          label: entry.label ?? entry.provider,
          testID: `collaboration-provider-option-${entry.provider}`,
        })),
      modelOptions: {
        director: modelOptions(selections.director),
        worker: modelOptions(selections.worker),
        reviewer: modelOptions(selections.reviewer),
      },
    };
  }
  function modelOptions(selection: ModelSelection | null) {
    return models(selection?.provider ?? "").map((model) => ({
      id: model.id,
      value: model.id,
      label: model.label,
      testID: `collaboration-model-option-${model.id}`,
    }));
  }
  function taskSettings(): Settings | undefined {
    if (snapshot.conversation) return undefined;
    function profile(role: LaunchRole): Profile {
      const selection = selections[role]!;
      const provider = entries.find((entry) => entry.provider === selection.provider)!;
      return {
        id: role,
        label: selection.modelLabel,
        provider: `${selection.provider}/${selection.model}`,
        modeId: provider.defaultModeId ?? undefined,
        transport: "mcp",
      };
    }
    const profiles = [profile("worker")];
    let directorProfileId = "worker";
    if (state.showDirector) {
      profiles.push(profile("director"));
      directorProfileId = "director";
    }
    if (selections.reviewer) profiles.push(profile("reviewer"));
    return SettingsSchema.parse({
      profiles,
      directorProfileId,
      workerProfileId: "worker",
      reviewerProfileId: selections.reviewer ? "reviewer" : undefined,
    });
  }
  let state = read();
  function publish() {
    state = read();
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySnapshot(next: LaunchSnapshot) {
      snapshot = next;
      if (!seeded && next.ready !== false) {
        selections = restored ?? seed(next.conversation?.settings ?? next.settings);
        seeded = true;
      }
      if (!modeSelected) mode = collaborationMode(next.conversation ?? {});
      if (!isolationSelected) isolation = next.conversation?.isolation ?? "local";
      publish();
    },
    applyProviders(next: ProviderSnapshotEntry[]) {
      entries = next;
      publish();
    },
    selectProvider(role: LaunchRole, provider: string, label: string) {
      if (pending || state.agentsLocked) return;
      let selection: ModelSelection | null = null;
      if (provider) selection = { provider, providerLabel: label, model: "", modelLabel: "" };
      selections = { ...selections, [role]: selection };
      error = "";
      publish();
    },
    selectModel(role: LaunchRole, model: string, label: string) {
      if (pending || state.agentsLocked || !selections[role]) return;
      selections = { ...selections, [role]: { ...selections[role], model, modelLabel: label } };
      error = "";
      publish();
    },
    selectMode(next: CollaborationMode) {
      if (pending || state.locked) return;
      modeSelected = true;
      mode = next;
      error = "";
      publish();
    },
    selectIsolation(next: CollaborationIsolation) {
      if (pending || state.locked) return;
      isolationSelected = true;
      isolation = next;
      error = "";
      publish();
    },
    async start(
      launch: (
        mode: CollaborationMode,
        settings: Settings | undefined,
        isolation: CollaborationIsolation,
      ) => Promise<void>,
    ) {
      if (!state.canContinue) return;
      const settings = taskSettings();
      pending = true;
      error = "";
      publish();
      try {
        await launch(mode, settings, isolation);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        pending = false;
        publish();
      }
    },
    close() {
      listeners.clear();
    },
  };
}
