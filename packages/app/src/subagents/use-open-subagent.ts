import { useCallback } from "react";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { planSubagentOpen } from "@/subagents/open-subagent";
import {
  openPreferredWorkspaceTarget,
  openWorkspaceTargetAtLocation,
} from "@/workspace-tabs/open-beside";

/**
 * Opens a Paseo subagent as a tab in the pane's own workspace.
 *
 * The display workspace comes from the pane context — the workspace the user is reading — never
 * from the caller or the subagent. The subagent's own workspace only decides whether the tab
 * needs the explicit-open pin. An already-open agent reveals its existing tab instead of creating
 * another. See `planSubagentOpen` for the policy.
 */
export function useOpenSubagent(input: { serverId: string }): (subagentId: string) => void {
  const { tabId, openTab, workspaceId: displayWorkspaceId } = usePaneContext();
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);

  return useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[input.serverId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      const plan = planSubagentOpen({
        serverId: input.serverId,
        displayWorkspaceId,
        subagentWorkspaceId: agent?.workspaceId,
        canSplit,
      });
      const target = { kind: "agent", agentId: subagentId } as const;

      if (plan.kind === "preferred") {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey: plan.workspaceKey,
          target,
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
          pin: plan.pin,
        });
        return;
      }
      if (plan.kind === "location") {
        openWorkspaceTargetAtLocation({
          isCompact,
          workspaceKey: plan.workspaceKey,
          target,
          location: "main",
          parentTabId: tabId,
          pin: plan.pin,
        });
        return;
      }
      openTab(target);
    },
    [canSplit, displayWorkspaceId, input.serverId, isCompact, openInSidePane, openTab, tabId],
  );
}
