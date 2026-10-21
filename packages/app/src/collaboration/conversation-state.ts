import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";
import { manualSwitchTarget } from "./execution-switch";

export type Conversation = CollaborationState["conversations"][number];
export type Control = "pause" | "resume" | "retry" | "cancel" | "switch";

export function executionModelLabel({ settings, run }: Conversation) {
  return (
    run?.execution?.model?.provider ??
    settings?.profiles.find((entry) => entry.id === run?.execution?.profileId)?.provider
  );
}

export function collaborationStage(phase: string): number {
  switch (phase) {
    case "planning":
      return 0;
    case "executing":
      return 1;
    case "reviewing":
    case "final_review":
      return 2;
    default:
      return 3;
  }
}

export function composerControl(conversation: Conversation) {
  if (conversation.confirmation || conversation.disabledAt) return undefined;
  return availableControls(conversation.run).find(
    (value) => value === "pause" || value === "resume" || value === "retry",
  );
}

export function conversationStatus({ run, error, disabledAt }: Conversation): {
  label: string;
  variant: StatusBadgeVariant;
} {
  if (disabledAt) return { label: "disabled", variant: "muted" };
  if (!run)
    return error
      ? { label: "needsAttention", variant: "error" }
      : { label: "ready", variant: "muted" };
  if (run.control === "canceled") return { label: "canceled", variant: "muted" };
  if (run.control === "canceling") return { label: "canceling", variant: "muted" };
  if (run.phase === "completed" && run.deliveryStatus !== "failed")
    return { label: "completed", variant: "success" };
  if (error || run.control === "needs_attention")
    return { label: "needsAttention", variant: "error" };
  if (run.control === "paused") return { label: "paused", variant: "warning" };
  if (run.deliveryStatus === "failed") return { label: "needsAttention", variant: "error" };
  if (run.control === "waiting_permission")
    return { label: "waitingPermission", variant: "warning" };
  if (run.phase === "awaiting_acceptance")
    return { label: "awaitingAcceptance", variant: "warning" };
  return { label: "running", variant: "muted" };
}

export function availableControls(run: Conversation["run"]): Control[] {
  if (
    !run ||
    (run.phase === "completed" && run.deliveryStatus !== "failed") ||
    run.control === "canceled"
  )
    return [];
  if (run.phase === "awaiting_acceptance") return ["cancel"];
  if (run.control === "paused") return ["resume", "cancel"];
  if (run.control === "needs_attention") {
    const actions: Control[] = ["retry", "cancel"];
    if (manualSwitchTarget(run)) actions.unshift("switch");
    return actions;
  }
  // A timeout stop in progress can still be canceled; cancel does not wait for the AI.
  if (run.control === "canceling") return ["cancel"];
  return ["pause", "cancel"];
}
