import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { CollaborationMode } from "@getpaseo/protocol/collaboration/schema";
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
  inlineModels: boolean;
  executeReview: boolean;
  worktree: boolean;
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
  if (!input.capabilities.inlineModels) return { kind: "configure" };
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
  if (resolution.mode === "execute_review" && !input.capabilities.executeReview) {
    return { kind: "configure" };
  }
  if (resolution.isolation === "worktree" && !input.capabilities.worktree) {
    return { kind: "configure" };
  }
  return { kind: "start", resolution };
}
