import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ExecutionModel } from "@getpaseo/protocol/collaboration/schema";
import type { SwitchExecutorInput } from "@getpaseo/protocol/collaboration/rpc";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export interface ExecutionSwitchNotice {
  operationId: string;
  token: number;
}

export interface ExecutionSwitchRun {
  id: string;
  phase: string;
  control: string;
  execution?: {
    model?: ExecutionModel;
    relay?: {
      status: "blocked" | "stopping" | "preparing" | "failed";
      manual: boolean;
      errorClass: "quota";
      operationId: string;
      token: number;
      attempted: ExecutionModel[];
      message: string;
      target?: ExecutionModel;
      reason?: string;
    };
  };
}

export interface ExecutionSwitchTarget {
  runId: string;
  expectedOperationId: string;
  token: number;
  current?: ExecutionModel;
  attempted: ExecutionModel[];
  message: string;
  reason?: string;
  status: "blocked" | "failed";
}

/** The live quota block a person can continue, or null when this stage must not offer it. */
export function manualSwitchTarget(
  run: ExecutionSwitchRun | undefined,
  notice?: ExecutionSwitchNotice,
): ExecutionSwitchTarget | null {
  const relay = run?.execution?.relay;
  if (!run || !relay || !relay.manual || relay.errorClass !== "quota") return null;
  if (run.control !== "needs_attention") return null;
  if (run.phase === "completed" || run.phase === "awaiting_acceptance") return null;
  if (relay.status !== "blocked" && relay.status !== "failed") return null;
  if (notice && (notice.operationId !== relay.operationId || notice.token !== relay.token))
    return null;
  return {
    runId: run.id,
    expectedOperationId: relay.operationId,
    token: relay.token,
    current: run.execution?.model,
    attempted: relay.attempted,
    message: relay.message,
    reason: relay.reason,
    status: relay.status,
  };
}

export interface ExecutionSwitchChoice {
  provider: string;
  model: string;
  thinkingOptionId?: string;
}

/** Same shape as the server receipt fingerprint, so one choice keeps one request id. */
function attemptKey(model: ExecutionModel): string {
  return JSON.stringify({
    provider: model.provider,
    thinkingOptionId: model.thinkingOptionId ?? null,
    featureValues: model.featureValues ?? null,
  });
}

function createRandomRequestId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("request id source is unavailable");
  return id;
}

interface SwitchOption {
  id: string;
  value: string;
  label: string;
  testID: string;
}

export interface ExecutionSwitchState {
  provider: string;
  model: string;
  thinkingOptionId: string;
  providerLabel: string;
  modelLabel: string;
  thinkingOptionLabel: string;
  providerOptions: SwitchOption[];
  modelOptions: SwitchOption[];
  thinkingOptions: SwitchOption[];
  support: boolean | null;
  pending: boolean;
  error: string;
  succeededLabel: string;
  canSubmit: boolean;
  status: "idle" | "pending" | "success" | "error";
}

/**
 * One open switch form. A request id belongs to one provider, model, and thinking
 * level. Retrying that choice after a network or stop error reuses it. Changing
 * any of those starts a new id and keeps the operation token from this open.
 */
export function openExecutionSwitch(input: {
  requestId: string;
  runId: string;
  expectedOperationId: string;
  token: number;
  createRequestId?: () => string;
}) {
  const createRequestId = input.createRequestId ?? createRandomRequestId;
  const attemptIds = new Map<string, string>();
  let entries: ProviderSnapshotEntry[] = [];
  let support: boolean | null = null;
  let provider = "";
  let providerLabel = "";
  let modelId = "";
  let modelLabel = "";
  let thinkingOptionId = "";
  let thinkingOptionLabel = "";
  let pending = false;
  let error = "";
  let succeededLabel = "";
  let busy = false;
  const listeners = new Set<() => void>();

  function catalogModels(providerId: string) {
    const entry = entries.find(
      (candidate) => candidate.provider === providerId && candidate.enabled,
    );
    return filterSelectableModels(entry?.models ?? null) ?? [];
  }
  function selectedModel() {
    return catalogModels(provider).find((candidate) => candidate.id === modelId);
  }
  function thinkingReady() {
    if (!thinkingOptionId) return true;
    return Boolean(
      selectedModel()?.thinkingOptions?.some((option) => option.id === thinkingOptionId),
    );
  }
  function choice(): ExecutionModel | undefined {
    if (!provider || !modelId || !selectedModel() || !thinkingReady()) return undefined;
    return {
      provider: `${provider}/${modelId}`,
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }
  function requestIdFor(model: ExecutionModel): string {
    const key = attemptKey(model);
    const existing = attemptIds.get(key);
    if (existing) return existing;
    const requestId = attemptIds.size === 0 ? input.requestId : createRequestId();
    attemptIds.set(key, requestId);
    return requestId;
  }
  function read(): ExecutionSwitchState {
    const selected = selectedModel();
    const canSubmit = support === true && !pending && !succeededLabel && Boolean(choice());
    let status: ExecutionSwitchState["status"] = "idle";
    if (pending) status = "pending";
    else if (succeededLabel) status = "success";
    else if (error) status = "error";
    return {
      provider,
      model: modelId,
      thinkingOptionId,
      providerLabel,
      modelLabel,
      thinkingOptionLabel,
      providerOptions: entries
        .filter((entry) => entry.enabled)
        .map((entry) => ({
          id: entry.provider,
          value: entry.provider,
          label: entry.label ?? entry.provider,
          testID: `collaboration-switch-provider-option-${entry.provider}`,
        })),
      modelOptions: catalogModels(provider).map((candidate) => ({
        id: candidate.id,
        value: candidate.id,
        label: candidate.label,
        testID: `collaboration-switch-model-option-${candidate.id}`,
      })),
      thinkingOptions: (selected?.thinkingOptions ?? []).map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label ?? option.id,
        testID: `collaboration-switch-thinking-option-${option.id}`,
      })),
      support,
      pending,
      error,
      succeededLabel,
      canSubmit,
      status,
    };
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
      return () => listeners.delete(listener);
    },
    applyProviders(next: ProviderSnapshotEntry[]) {
      entries = next;
      publish();
    },
    applySupport(next: boolean | null) {
      support = next;
      publish();
    },
    selectProvider(next: string, label: string) {
      if (pending || succeededLabel) return;
      provider = next;
      providerLabel = label;
      modelId = "";
      modelLabel = "";
      thinkingOptionId = "";
      thinkingOptionLabel = "";
      error = "";
      publish();
    },
    selectModel(next: string, label: string) {
      if (pending || succeededLabel || !provider) return;
      const same = modelId === next;
      modelId = next;
      modelLabel = label;
      if (!same) {
        thinkingOptionId = "";
        thinkingOptionLabel = "";
      }
      error = "";
      publish();
    },
    selectThinking(next: string, label: string) {
      if (pending || succeededLabel || !modelId) return;
      const supported = state.thinkingOptions.some((option) => option.id === next);
      if (next && !supported) return;
      thinkingOptionId = next;
      thinkingOptionLabel = next ? label : "";
      error = "";
      publish();
    },
    async submit(send: (input: SwitchExecutorInput) => Promise<void>) {
      const model = choice();
      if (busy || pending || succeededLabel || support !== true || !model) return;
      busy = true;
      pending = true;
      error = "";
      publish();
      try {
        await send({
          id: input.runId,
          expectedOperationId: input.expectedOperationId,
          token: input.token,
          requestId: requestIdFor(model),
          model,
        });
        succeededLabel = thinkingOptionId
          ? `${model.provider} · ${thinkingOptionLabel}`
          : model.provider;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        pending = false;
        busy = false;
        publish();
      }
    },
    close() {
      listeners.clear();
    },
  };
}
