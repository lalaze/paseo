import { create } from "zustand";

/** The two one-tap operations the composer's collaboration control runs, and how to retry them. */
export type CollaborationAction = "enable" | "disable";

interface CollaborationEnableState {
  pending: Record<string, boolean>;
  errors: Record<string, string>;
  /** The request id an in-flight (or failed) enable used, so a retry resumes the same request. */
  requests: Record<string, string>;
  /** The operation behind the current pending/error, so a failure retries the right one. */
  actions: Record<string, CollaborationAction>;
  /**
   * The conversation id a disable targeted, so a retry closes that same record. Re-resolving by
   * agent would close a fresh conversation the same agent opened after the failed attempt.
   */
  disableTargets: Record<string, string>;
}

/**
 * The one-tap enable/disable is a background request. The composer's send reads this store
 * synchronously so a send cannot race either operation, and the control and the send agree on
 * one flag. Keyed by the composer's own agent id (a draft tab has one too).
 */
export const useCollaborationEnableStore = create<CollaborationEnableState>(() => ({
  pending: {},
  errors: {},
  requests: {},
  actions: {},
  disableTargets: {},
}));

export function collaborationEnableKey(serverId: string, agentId: string | null | undefined) {
  return `${serverId}:${agentId ?? ""}`;
}

/** Synchronous read for send paths that must not fire while an enable or disable is in flight. */
export function isCollaborationEnablePending(serverId: string, agentId: string | null | undefined) {
  return selectCollaborationEnabling(
    useCollaborationEnableStore.getState(),
    collaborationEnableKey(serverId, agentId),
  );
}

export function beginCollaborationEnable(
  key: string,
  requestId?: string,
  action: CollaborationAction = "enable",
  disableTargetId?: string,
) {
  useCollaborationEnableStore.setState((state) => {
    const pending = { ...state.pending, [key]: true };
    const errors = { ...state.errors };
    delete errors[key];
    const requests = requestId ? { ...state.requests, [key]: requestId } : state.requests;
    const actions = { ...state.actions, [key]: action };
    const disableTargets =
      disableTargetId !== undefined
        ? { ...state.disableTargets, [key]: disableTargetId }
        : state.disableTargets;
    return { pending, errors, requests, actions, disableTargets };
  });
}

export function settleCollaborationEnable(key: string, error?: string) {
  useCollaborationEnableStore.setState((state) => {
    const pending = { ...state.pending };
    delete pending[key];
    const errors = { ...state.errors };
    const requests = { ...state.requests };
    const actions = { ...state.actions };
    const disableTargets = { ...state.disableTargets };
    if (error) {
      errors[key] = error;
      // Keep the request id and disable target so a retry resumes the same request/conversation.
    } else {
      delete errors[key];
      delete requests[key];
      delete actions[key];
      delete disableTargets[key];
    }
    return { pending, errors, requests, actions, disableTargets };
  });
}

/** Records a failure that never reached the host (e.g. a missing capability) without a pending phase. */
export function failCollaborationAction(key: string, message: string, action: CollaborationAction) {
  useCollaborationEnableStore.setState((state) => ({
    errors: { ...state.errors, [key]: message },
    actions: { ...state.actions, [key]: action },
  }));
}

/** Clears a failure and the operation/target behind it, so a later press cannot retry a stale one. */
export function clearCollaborationError(key: string) {
  useCollaborationEnableStore.setState((state) => {
    if (!(key in state.errors) && !(key in state.actions) && !(key in state.disableTargets)) {
      return state;
    }
    const errors = { ...state.errors };
    delete errors[key];
    const actions = { ...state.actions };
    delete actions[key];
    const disableTargets = { ...state.disableTargets };
    delete disableTargets[key];
    return { errors, actions, disableTargets };
  });
}

export function selectCollaborationEnabling(state: CollaborationEnableState, key: string) {
  return state.pending[key] === true;
}

export function selectCollaborationError(state: CollaborationEnableState, key: string) {
  return state.errors[key] ?? null;
}

/** The request id a previous attempt used, so a retry is idempotent on the host. */
export function selectCollaborationRequest(state: CollaborationEnableState, key: string) {
  return state.requests[key] ?? null;
}

/** Which operation the current pending/error belongs to; `enable` when nothing is recorded. */
export function selectCollaborationAction(
  state: CollaborationEnableState,
  key: string,
): CollaborationAction {
  return state.actions[key] ?? "enable";
}

/** The conversation a disable targeted, so a retry closes the same record and not a new one. */
export function selectCollaborationDisableTarget(
  state: CollaborationEnableState,
  key: string,
): string | null {
  return state.disableTargets[key] ?? null;
}
