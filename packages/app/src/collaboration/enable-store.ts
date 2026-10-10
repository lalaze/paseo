import { create } from "zustand";

interface CollaborationEnableState {
  pending: Record<string, boolean>;
  errors: Record<string, string>;
  /** The request id an in-flight (or failed) enable used, so a retry resumes the same request. */
  requests: Record<string, string>;
}

/**
 * The one-tap enable is a background request. The composer's send reads this store
 * synchronously so a send cannot race the enable, and the control and the send agree on
 * one flag. Keyed by the composer's own agent id (a draft tab has one too).
 */
export const useCollaborationEnableStore = create<CollaborationEnableState>(() => ({
  pending: {},
  errors: {},
  requests: {},
}));

export function collaborationEnableKey(serverId: string, agentId: string | null | undefined) {
  return `${serverId}:${agentId ?? ""}`;
}

/** Synchronous read for send paths that must not fire while an enable is in flight. */
export function isCollaborationEnablePending(serverId: string, agentId: string | null | undefined) {
  return selectCollaborationEnabling(
    useCollaborationEnableStore.getState(),
    collaborationEnableKey(serverId, agentId),
  );
}

export function beginCollaborationEnable(key: string, requestId?: string) {
  useCollaborationEnableStore.setState((state) => {
    const pending = { ...state.pending, [key]: true };
    const errors = { ...state.errors };
    delete errors[key];
    const requests = requestId ? { ...state.requests, [key]: requestId } : state.requests;
    return { pending, errors, requests };
  });
}

export function settleCollaborationEnable(key: string, error?: string) {
  useCollaborationEnableStore.setState((state) => {
    const pending = { ...state.pending };
    delete pending[key];
    const errors = { ...state.errors };
    const requests = { ...state.requests };
    if (error) {
      errors[key] = error;
      // Keep the request id so a retry resumes the same conversation instead of adding another.
    } else {
      delete errors[key];
      delete requests[key];
    }
    return { pending, errors, requests };
  });
}

export function clearCollaborationError(key: string) {
  useCollaborationEnableStore.setState((state) => {
    if (!(key in state.errors)) return state;
    const errors = { ...state.errors };
    delete errors[key];
    return { errors };
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
