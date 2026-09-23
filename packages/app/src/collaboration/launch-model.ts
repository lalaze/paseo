import {
  collaborationMode,
  type CollaborationMode,
  type Settings,
} from "@getpaseo/protocol/collaboration/schema";
import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";

export interface LaunchSnapshot {
  settings: Settings | null;
  conversation?: CollaborationState["conversations"][number];
  supportsExecuteReview: boolean;
}

export function openCollaborationLaunch(initial: LaunchSnapshot, selected?: CollaborationMode) {
  let snapshot = initial;
  let mode = selected ?? collaborationMode(initial.conversation ?? {});
  let modeSelected = selected !== undefined;
  let pending = false;
  let error = "";
  const listeners = new Set<() => void>();
  function read() {
    const locked = Boolean(snapshot.conversation?.run);
    if (locked) mode = collaborationMode(snapshot.conversation!);
    let blocked: "configure" | "reviewerRequired" | "updateHost" | null = null;
    if (!snapshot.settings) blocked = "configure";
    if (mode === "execute_review") {
      if (!snapshot.settings?.reviewerProfileId) blocked = "reviewerRequired";
      if (!snapshot.supportsExecuteReview) blocked = "updateHost";
    }
    // Reopening an existing task does not create a new run or change its saved profiles.
    if (locked) blocked = null;
    const settings = snapshot.settings;
    return {
      mode,
      locked,
      pending,
      error,
      blocked,
      canContinue: !pending && blocked === null,
      supportsExecuteReview: snapshot.supportsExecuteReview,
      worker: settings?.profiles.find((p) => p.id === settings.workerProfileId)?.label,
      reviewer: settings?.profiles.find((p) => p.id === settings.reviewerProfileId)?.label,
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
      return () => {
        listeners.delete(listener);
      };
    },
    applySnapshot(next: LaunchSnapshot) {
      snapshot = next;
      if (!modeSelected) mode = collaborationMode(next.conversation ?? {});
      publish();
    },
    selectMode(next: CollaborationMode) {
      if (pending || state.locked) return;
      if (next === "execute_review" && !snapshot.supportsExecuteReview) return;
      modeSelected = true;
      mode = next;
      error = "";
      publish();
    },
    async start(launch: (mode: CollaborationMode) => Promise<void>) {
      if (!state.canContinue) return;
      pending = true;
      error = "";
      publish();
      try {
        await launch(mode);
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
