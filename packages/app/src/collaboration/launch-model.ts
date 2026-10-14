import {
  collaborationMode,
  EXECUTION_FALLBACK_LIMIT,
  SettingsSchema,
  type CollaborationIsolation,
  type CollaborationMode,
  type ExecutionModel,
  type Profile,
  type Settings,
} from "@getpaseo/protocol/collaboration/schema";
import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";

export type LaunchRole = "director" | "worker" | "reviewer";
export interface ModelSelection {
  provider: string;
  model: string;
  providerLabel: string;
  modelLabel: string;
  thinkingOptionId?: string;
  thinkingOptionLabel?: string;
  /** Stable row identity for the backup editor. It is not sent to the host. */
  rowKey?: string;
}
export type LaunchSelections = Record<LaunchRole, ModelSelection | null>;
export const DEFAULT_MAX_REWORKS = 2;
export const MAX_REWORKS_LIMIT = 10;
const HOUR_MS = 3600000;
export const DEFAULT_RUN_TIMEOUT_MS = 4 * HOUR_MS;
/** Time budget choices; the schema caps a round at 24 hours. */
export const RUN_TIMEOUT_HOURS = [1, 2, 4, 8, 12, 24] as const;
export interface LaunchLimits {
  maxReworks: number;
  runTimeoutMs: number;
  requirePlanApproval?: boolean;
}
/** The choices of the last task started on a host, which prefill the next new task. */
export interface LaunchPreferences extends LaunchLimits {
  mode: CollaborationMode;
  isolation: CollaborationIsolation;
  selections: LaunchSelections;
  /** Ordered execution backups. Absent or empty keeps quota handoff manual. */
  fallbacks?: ModelSelection[];
}
export type FallbackIssueCode =
  | "incomplete"
  | "duplicate"
  | "same"
  | "unavailable"
  | "thinking"
  | "limit";
export interface FallbackIssue {
  index: number;
  code: FallbackIssueCode;
}
export interface LaunchSnapshot {
  ready?: boolean;
  settings: Settings | null;
  conversation?: CollaborationState["conversations"][number];
  currentAgent: boolean;
  /** The conversation's live model, so the first execution inherits it instead of a host default. */
  currentModel?: ModelSelection | null;
}

/** The mode, isolation and settings a launch would send, or null when it cannot start yet. */
export interface LaunchResolution {
  mode: CollaborationMode;
  isolation: CollaborationIsolation;
  /** Absent for an existing conversation, which already carries its saved settings. */
  settings: Settings | undefined;
}

export function buildModelSelection(
  provider: string,
  model: string,
  thinkingOptionId?: string | null,
): ModelSelection {
  return {
    provider,
    model,
    providerLabel: provider,
    modelLabel: model,
    thinkingOptionId: thinkingOptionId ?? undefined,
    thinkingOptionLabel: thinkingOptionId
      ? formatThinkingOptionLabel({ id: thinkingOptionId })
      : undefined,
  };
}

export function copyModelSelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    providerLabel: selection.providerLabel,
    modelLabel: selection.modelLabel,
    thinkingOptionId: selection.thinkingOptionId,
    thinkingOptionLabel: selection.thinkingOptionLabel,
    rowKey: selection.rowKey,
  };
}

let fallbackSerial = 0;
function withRowKey(selection: ModelSelection): ModelSelection {
  const copy = copyModelSelection(selection);
  if (copy.rowKey) return copy;
  fallbackSerial += 1;
  copy.rowKey = `fb-${fallbackSerial}`;
  return copy;
}

export function executionModelFromSelection(selection: ModelSelection): ExecutionModel | undefined {
  if (!selection.provider || !selection.model) return undefined;
  return {
    provider: `${selection.provider}/${selection.model}`,
    ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
  };
}

export function selectionFromExecutionModel(model: ExecutionModel): ModelSelection {
  const slash = model.provider.indexOf("/");
  return buildModelSelection(
    slash < 0 ? model.provider : model.provider.slice(0, slash),
    slash < 0 ? "" : model.provider.slice(slash + 1),
    model.thinkingOptionId,
  );
}

/** Visible reasons a backup list cannot be saved. An unloaded catalog is "unknown", not invalid. */
export function collectFallbackIssues(
  fallbacks: readonly ModelSelection[],
  worker: ModelSelection | null,
  lookup: (selection: ModelSelection) => "ready" | "missing" | "thinking" | "unknown",
): FallbackIssue[] {
  const issues: FallbackIssue[] = [];
  if (fallbacks.length > EXECUTION_FALLBACK_LIMIT)
    issues.push({ index: EXECUTION_FALLBACK_LIMIT, code: "limit" });
  const seen = new Set<string>();
  const workerProvider =
    worker?.provider && worker.model ? `${worker.provider}/${worker.model}` : "";
  for (let index = 0; index < fallbacks.length; index += 1) {
    const selection = fallbacks[index]!;
    if (!selection.provider || !selection.model) {
      issues.push({ index, code: "incomplete" });
      continue;
    }
    const provider = `${selection.provider}/${selection.model}`;
    if (seen.has(provider)) issues.push({ index, code: "duplicate" });
    seen.add(provider);
    if (workerProvider && provider === workerProvider) issues.push({ index, code: "same" });
    const found = lookup(selection);
    if (found === "missing") issues.push({ index, code: "unavailable" });
    if (found === "thinking") issues.push({ index, code: "thinking" });
  }
  return issues;
}

function seedSelection(profile: Profile | undefined): ModelSelection | null {
  if (!profile) return null;
  const slash = profile.provider.indexOf("/");
  return buildModelSelection(
    profile.provider.slice(0, slash),
    profile.provider.slice(slash + 1),
    profile.thinkingOptionId,
  );
}

export function openCollaborationLaunch(
  initial: LaunchSnapshot,
  selected?: CollaborationMode,
  restored?: LaunchSelections,
  restoredLimits?: LaunchLimits,
  remembered?: LaunchPreferences,
  restoredFallbacks?: ModelSelection[],
) {
  // An existing conversation keeps its own choices; only a new task starts from the last one.
  function defaultMode(next: LaunchSnapshot): CollaborationMode {
    if (next.conversation) return collaborationMode(next.conversation);
    return remembered?.mode ?? "execute_review";
  }
  function defaultIsolation(next: LaunchSnapshot): CollaborationIsolation {
    if (next.conversation) return next.conversation.isolation ?? "local";
    return remembered?.isolation ?? "local";
  }
  let snapshot = initial;
  let mode = selected ?? defaultMode(initial);
  let modeSelected = selected !== undefined;
  let isolation = defaultIsolation(initial);
  let isolationSelected = false;
  let seeded = initial.ready !== false;
  function seed(settings: Settings | null | undefined): LaunchSelections {
    return {
      director: seedSelection(settings?.profiles.find((p) => p.id === settings.directorProfileId)),
      worker: seedSelection(settings?.profiles.find((p) => p.id === settings.workerProfileId)),
      reviewer: seedSelection(settings?.profiles.find((p) => p.id === settings.reviewerProfileId)),
    };
  }
  function initialSelections(next: LaunchSnapshot): LaunchSelections {
    if (restored) return restored;
    if (!next.conversation && remembered) return remembered.selections;
    // A first task inherits the conversation's own model; review stays unchosen.
    if (!next.conversation && next.currentModel)
      return { director: null, worker: next.currentModel, reviewer: null };
    return seed(next.conversation?.settings ?? next.settings);
  }
  let selections = initialSelections(initial);
  function seedFallbacks(settings: Settings | null | undefined): ModelSelection[] {
    const workerId = settings?.workerProfileId;
    const list = workerId ? settings?.executionFallbacks?.[workerId] : undefined;
    return (list ?? []).map(selectionFromExecutionModel).map(withRowKey);
  }
  function initialFallbacks(next: LaunchSnapshot): ModelSelection[] {
    if (restoredFallbacks !== undefined) return restoredFallbacks.map(withRowKey);
    if (next.conversation) return seedFallbacks(next.conversation.settings ?? next.settings);
    return (remembered?.fallbacks ?? []).map(withRowKey);
  }
  let fallbacks = initialFallbacks(initial);
  let fallbacksSeeded = initial.ready !== false;
  // New tasks start from the built-in limit, not the host's legacy advanced settings.
  let maxReworks = restoredLimits?.maxReworks ?? remembered?.maxReworks ?? DEFAULT_MAX_REWORKS;
  let runTimeoutMs =
    restoredLimits?.runTimeoutMs ?? remembered?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let requirePlanApproval =
    restoredLimits?.requirePlanApproval ?? remembered?.requirePlanApproval ?? false;
  let entries: ProviderSnapshotEntry[] = [];
  let pending = false;
  let error = "";
  const listeners = new Set<() => void>();
  function models(provider: string) {
    const entry = entries.find((candidate) => candidate.provider === provider && candidate.enabled);
    return filterSelectableModels(entry?.models ?? null) ?? [];
  }
  function valid(selection: ModelSelection | null) {
    if (!selection) return false;
    const selectedModel = models(selection.provider).find((model) => model.id === selection.model);
    if (!selectedModel) return false;
    return (
      !selection.thinkingOptionId ||
      Boolean(
        selectedModel.thinkingOptions?.some((option) => option.id === selection.thinkingOptionId),
      )
    );
  }
  function lookupFallback(selection: ModelSelection) {
    if (!entries.length) return "unknown" as const;
    const selectedModel = models(selection.provider).find((model) => model.id === selection.model);
    if (!selectedModel) return "missing" as const;
    if (
      selection.thinkingOptionId &&
      !selectedModel.thinkingOptions?.some((option) => option.id === selection.thinkingOptionId)
    )
      return "thinking" as const;
    return "ready" as const;
  }
  /** An existing conversation shows its saved limits; a new task uses the chosen ones. */
  function limits(): Required<LaunchLimits> {
    const saved = snapshot.conversation?.settings;
    return {
      maxReworks: saved?.maxReworks ?? maxReworks,
      runTimeoutMs: saved?.runTimeoutMs ?? runTimeoutMs,
      requirePlanApproval: saved?.requirePlanApproval ?? requirePlanApproval,
    };
  }
  function read() {
    const locked = Boolean(snapshot.conversation?.run);
    if (locked) {
      mode = collaborationMode(snapshot.conversation!);
      isolation = snapshot.conversation?.isolation ?? "local";
    }
    const agentsLocked = Boolean(snapshot.conversation);
    // COMPAT(collaborationUnified): added in v0.11.1, remove after 2027-04-11 once legacy conversations no longer have a separate lead.
    const legacyLead = Boolean(
      snapshot.conversation && !snapshot.conversation.settings?.reviewerAsLead,
    );
    const showDirector = legacyLead && !snapshot.currentAgent && mode === "full";
    const complete = valid(selections.worker) && valid(selections.reviewer);
    const savedReviewer = snapshot.conversation?.settings?.reviewerProfileId;
    const canReopen = mode === "full" || Boolean(savedReviewer);
    const issues = collectFallbackIssues(fallbacks, selections.worker, lookupFallback);
    const fallbacksReady = issues.length === 0;
    return {
      mode,
      isolation,
      locked,
      agentsLocked,
      showDirector,
      selections,
      ...limits(),
      pending,
      error,
      canContinue:
        snapshot.ready !== false &&
        !pending &&
        (agentsLocked ? canReopen : complete && fallbacksReady),
      fallbacks,
      fallbackIssues: issues,
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
      thinkingOptions: {
        director: thinkingOptions(selections.director),
        worker: thinkingOptions(selections.worker),
        reviewer: thinkingOptions(selections.reviewer),
      },
      fallbackModelOptions: fallbacks.map((selection) => modelOptions(selection)),
      fallbackThinkingOptions: fallbacks.map((selection) => thinkingOptions(selection)),
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
  function thinkingOptions(selection: ModelSelection | null) {
    const selectedModel = models(selection?.provider ?? "").find(
      (model) => model.id === selection?.model,
    );
    return (selectedModel?.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      value: option.id,
      label: formatThinkingOptionLabel(option),
      testID: `collaboration-thinking-option-${option.id}`,
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
        thinkingOptionId: selection.thinkingOptionId || undefined,
        transport: "mcp",
      };
    }
    const profiles = [profile("worker"), profile("reviewer")];
    const backup = fallbacks.flatMap((selection) => {
      const model = executionModelFromSelection(selection);
      return model ? [model] : [];
    });
    return SettingsSchema.parse({
      profiles,
      directorProfileId: "reviewer",
      workerProfileId: "worker",
      reviewerProfileId: "reviewer",
      reviewerAsLead: true,
      requirePlanApproval: mode === "full" && requirePlanApproval,
      maxReworks,
      runTimeoutMs,
      ...(backup.length ? { executionFallbacks: { worker: backup } } : {}),
    });
  }
  let state = read();
  function publish() {
    state = read();
    for (const listener of listeners) listener();
  }
  function resolveLaunch(): LaunchResolution | null {
    if (!state.canContinue) return null;
    return { mode: state.mode, isolation: state.isolation, settings: taskSettings() };
  }
  return {
    getState: () => state,
    preferences: (): LaunchPreferences => {
      const saved: LaunchPreferences = {
        mode: state.mode,
        isolation: state.isolation,
        selections: state.selections,
        maxReworks: state.maxReworks,
        runTimeoutMs: state.runTimeoutMs,
        requirePlanApproval: state.requirePlanApproval,
      };
      if (state.fallbacks.length) saved.fallbacks = state.fallbacks.map(withRowKey);
      return saved;
    },
    /** What a launch would send right now, or null when the setup is incomplete or locked out. */
    resolve: resolveLaunch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySnapshot(next: LaunchSnapshot) {
      snapshot = next;
      if (!seeded && next.ready !== false) {
        selections = initialSelections(next);
        seeded = true;
      }
      if (!fallbacksSeeded && next.ready !== false) {
        fallbacks = initialFallbacks(next);
        fallbacksSeeded = true;
      }
      if (!modeSelected) mode = defaultMode(next);
      if (!isolationSelected) isolation = defaultIsolation(next);
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
      const previous = selections[role];
      const same = previous.model === model;
      selections = {
        ...selections,
        [role]: {
          ...previous,
          model,
          modelLabel: label,
          thinkingOptionId: same ? previous.thinkingOptionId : undefined,
          thinkingOptionLabel: same ? previous.thinkingOptionLabel : undefined,
        },
      };
      error = "";
      publish();
    },
    selectThinking(role: LaunchRole, thinkingOptionId: string, label: string) {
      if (pending || state.agentsLocked || !selections[role]) return;
      const supported = state.thinkingOptions[role].some(
        (option) => option.id === thinkingOptionId,
      );
      if (thinkingOptionId && !supported) return;
      selections = {
        ...selections,
        [role]: {
          ...selections[role],
          thinkingOptionId: thinkingOptionId || undefined,
          thinkingOptionLabel: thinkingOptionId ? label : undefined,
        },
      };
      error = "";
      publish();
    },
    selectMaxReworks(next: number) {
      if (pending || state.agentsLocked) return;
      maxReworks = Math.min(MAX_REWORKS_LIMIT, Math.max(0, Math.trunc(next)));
      error = "";
      publish();
    },
    selectRunTimeout(next: number) {
      if (pending || state.agentsLocked) return;
      runTimeoutMs = Math.min(24 * HOUR_MS, Math.max(HOUR_MS, Math.trunc(next)));
      error = "";
      publish();
    },
    addFallback() {
      if (pending || state.agentsLocked || fallbacks.length >= EXECUTION_FALLBACK_LIMIT) return;
      fallbacks = fallbacks.concat([
        withRowKey({ provider: "", model: "", providerLabel: "", modelLabel: "" }),
      ]);
      error = "";
      publish();
    },
    removeFallback(index: number) {
      if (pending || state.agentsLocked || index < 0 || index >= fallbacks.length) return;
      fallbacks = fallbacks.filter((_, item) => item !== index);
      error = "";
      publish();
    },
    moveFallback(index: number, direction: -1 | 1) {
      if (pending || state.agentsLocked) return;
      const target = index + direction;
      if (index < 0 || target < 0 || index >= fallbacks.length || target >= fallbacks.length)
        return;
      const next = fallbacks.slice();
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      fallbacks = next;
      error = "";
      publish();
    },
    selectFallbackProvider(index: number, provider: string, label: string) {
      if (pending || state.agentsLocked || !fallbacks[index]) return;
      const next = fallbacks.slice();
      next[index] = withRowKey({
        provider,
        providerLabel: label,
        model: "",
        modelLabel: "",
        rowKey: fallbacks[index].rowKey,
      });
      fallbacks = next;
      error = "";
      publish();
    },
    selectFallbackModel(index: number, model: string, label: string) {
      if (pending || state.agentsLocked || !fallbacks[index]) return;
      const previous = fallbacks[index];
      const same = previous.model === model;
      const next = fallbacks.slice();
      next[index] = withRowKey({
        provider: previous.provider,
        providerLabel: previous.providerLabel,
        model,
        modelLabel: label,
        thinkingOptionId: same ? previous.thinkingOptionId : undefined,
        thinkingOptionLabel: same ? previous.thinkingOptionLabel : undefined,
        rowKey: previous.rowKey,
      });
      fallbacks = next;
      error = "";
      publish();
    },
    selectFallbackThinking(index: number, thinkingOptionId: string, label: string) {
      if (pending || state.agentsLocked || !fallbacks[index]) return;
      const supported = state.fallbackThinkingOptions[index]?.some(
        (option) => option.id === thinkingOptionId,
      );
      if (thinkingOptionId && !supported) return;
      const previous = fallbacks[index];
      const next = fallbacks.slice();
      next[index] = withRowKey({
        provider: previous.provider,
        providerLabel: previous.providerLabel,
        model: previous.model,
        modelLabel: previous.modelLabel,
        thinkingOptionId: thinkingOptionId || undefined,
        thinkingOptionLabel: thinkingOptionId ? label : undefined,
        rowKey: previous.rowKey,
      });
      fallbacks = next;
      error = "";
      publish();
    },
    selectRequirePlanApproval(next: boolean) {
      if (pending || state.agentsLocked) return;
      requirePlanApproval = next;
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
      const resolution = resolveLaunch();
      if (!resolution) return;
      pending = true;
      error = "";
      publish();
      try {
        await launch(resolution.mode, resolution.settings, resolution.isolation);
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
