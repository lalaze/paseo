import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type {
  CollaborationIsolation,
  CollaborationMode,
  Settings,
} from "@getpaseo/protocol/collaboration/schema";
import {
  openCollaborationLaunch,
  type LaunchLimits,
  type LaunchPreferences,
  type LaunchResolution,
  type LaunchSelections,
  type LaunchSnapshot,
} from "./launch-model";

export type QuickLaunch = { kind: "start"; resolution: LaunchResolution } | { kind: "configure" };

/** What the host can run. The form disables the same choices; quick launch refuses them too. */
export interface QuickLaunchCapabilities {
  unified: boolean;
  worktree: boolean;
  /** False when the host does not advertise collaborationExecutionHandoff, including while unknown. */
  executionHandoff: boolean;
}

export function settingsUseExecutionHandoff(settings: Settings | undefined): boolean {
  return Object.values(settings?.executionFallbacks ?? {}).some((list) => list.length > 0);
}

/** Shared by the dialog button and quick launch. Unknown host support stays inactive. */
export function canStartCollaboration(input: {
  ready: boolean | undefined;
  canContinue: boolean;
  isolation: CollaborationIsolation;
  supportsWorktree: boolean | null;
  agentsLocked: boolean;
  fallbackCount: number;
  supportsHandoff: boolean | null;
}): boolean {
  if (!input.ready || !input.canContinue) return false;
  if (input.isolation === "worktree" && input.supportsWorktree !== true) return false;
  if (!input.agentsLocked && input.fallbackCount > 0 && input.supportsHandoff !== true)
    return false;
  return true;
}

/**
 * The one-tap decision behind the composer's collaboration control: reuse the last valid setup,
 * or fall back to the form. It runs the same launch model the dialog renders, so it can never
 * start a task the dialog would refuse (missing reviewer, unavailable model, locked run).
 *
 * A first task never quick-starts: with nothing remembered and no conversation, there is no setup
 * to reuse, and the inherited model alone would resolve a partial workflow.
 */
export function resolveQuickLaunch(input: {
  snapshot: LaunchSnapshot;
  remembered?: LaunchPreferences;
  providers: ProviderSnapshotEntry[];
  capabilities: QuickLaunchCapabilities;
  mode?: CollaborationMode;
  selections?: LaunchSelections;
  limits?: LaunchLimits;
}): QuickLaunch {
  if (!input.capabilities.unified) return { kind: "configure" };
  if (!input.remembered && !input.snapshot.conversation) return { kind: "configure" };
  const model = openCollaborationLaunch(
    input.snapshot,
    input.mode,
    input.selections,
    input.limits,
    input.remembered,
  );
  model.applyProviders(input.providers);
  const resolution = model.resolve();
  model.close();
  if (!resolution) return { kind: "configure" };
  if (resolution.isolation === "worktree" && !input.capabilities.worktree) {
    return { kind: "configure" };
  }
  if (settingsUseExecutionHandoff(resolution.settings) && !input.capabilities.executionHandoff) {
    return { kind: "configure" };
  }
  return { kind: "start", resolution };
}
