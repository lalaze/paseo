import { memo, useCallback, type ReactElement } from "react";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { PluginComposerPills } from "@/plugins";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  useSubagentOpensInSheet,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import { useOpenSubagent } from "@/subagents/use-open-subagent";
import type { TodoEntry } from "@/types/stream";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { planAgentChangesOpen } from "@/workspace-tabs/open-agent-changes";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";

/**
 * The pane's ambient context — workspace changes, subagents, and tasks — as a row of pills above
 * the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 *
 * Two workspaces are in play. Tabs and split placement belong to the pane's display workspace
 * (`usePaneContext`). Diff, changes and plugin data belong to the agent's own workspace, which
 * differs when a collaboration worker is shown in the main conversation.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  agentWorkspaceId,
  agentId,
  cwd,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
  hasPluginComposerPills,
}: {
  serverId: string;
  /** The agent's own workspace, where its diff and plugin data live. */
  agentWorkspaceId: string;
  agentId: string;
  cwd: string;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  hasPluginComposerPills: boolean;
}): ReactElement | null {
  const { tabId, workspaceId: displayWorkspaceId } = usePaneContext();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, agentWorkspaceId);
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const displayWorkspaceKey = buildWorkspaceTabPersistenceKey({
    serverId,
    workspaceId: displayWorkspaceId,
  });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  // Subagent tabs belong to the workspace the user is reading, so a collaboration worker's
  // children open next to it rather than in the worker's hidden worktree.
  const handleOpenSubagent = useOpenSubagent({ serverId });
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openPreferredWorkspaceTarget({
        workspaceKey: displayWorkspaceKey,
        target: { kind: "provider_subagent", parentAgentId, subagentId },
        source: "subagents",
        preferences: openInSidePane,
        parentTabId: tabId,
      });
    },
    [displayWorkspaceKey, openInSidePane, tabId],
  );
  const opensInSheet = useSubagentOpensInSheet(displayWorkspaceKey);
  const handleOpenChanges = useCallback(() => {
    const plan = planAgentChangesOpen({
      serverId,
      displayWorkspaceId,
      agentWorkspaceId,
      opensInPane: canSplit,
    });
    if (!plan) {
      return;
    }
    if (plan.kind === "navigate") {
      navigateToWorkspace({
        serverId,
        workspaceId: plan.workspaceId,
        target: { kind: "working_diff" },
      });
      return;
    }
    openComposerChanges({
      isCompact,
      workspaceKey: plan.workspaceKey,
      checkout: { serverId, cwd, isGit: true },
      preferences: openInSidePane,
    });
  }, [agentWorkspaceId, canSplit, cwd, displayWorkspaceId, isCompact, openInSidePane, serverId]);

  if (
    !hasWorkspaceDiffStat &&
    !hasAgentTracks({
      subagentRows,
      tasks,
      archiveFinishedStatus,
      hasPluginComposerPills,
    })
  ) {
    return null;
  }

  return (
    <ComposerTrackBar>
      <AgentTaskList tasks={tasks} />
      <SubagentsTrack
        serverId={serverId}
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        opensInSheet={opensInSheet}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <PluginComposerPills
        serverId={serverId}
        workspaceId={agentWorkspaceId}
        agentId={agentId}
        compact={isCompact}
      />
      <WorkspaceDiffStatPill
        serverId={serverId}
        workspaceId={agentWorkspaceId}
        onPress={handleOpenChanges}
      />
    </ComposerTrackBar>
  );
});

export function hasAgentTracks({
  subagentRows,
  tasks,
  archiveFinishedStatus,
  hasPluginComposerPills = false,
}: {
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  hasPluginComposerPills?: boolean;
}): boolean {
  return (
    subagentRows.length > 0 ||
    Boolean(tasks?.length) ||
    archiveFinishedStatus.kind !== "idle" ||
    hasPluginComposerPills
  );
}
