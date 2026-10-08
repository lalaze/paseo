import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import type { WorkspaceDescriptor } from "@/stores/session-store";

// The daemon cuts a task's New worktree isolation as `director-<run id>`; see
// createIsolatedWorkspace in packages/server/src/server/bootstrap.ts.
const COLLABORATION_WORKTREE_SLUG = /^director-[0-9a-f]{24}$/;

interface WorkspaceSessions {
  [serverId: string]: { workspaces: Map<string, WorkspaceDescriptor> } | undefined;
}

export function isCollaborationWorktree(
  workspace: Pick<WorkspaceDescriptor, "worktreeSlug">,
): boolean {
  return !!workspace.worktreeSlug && COLLABORATION_WORKTREE_SLUG.test(workspace.worktreeSlug);
}

/**
 * Workspace keys the sidebar leaves out. Collaboration worktrees are the task's workspace, not
 * the user's: worker sessions are reached as children of the main conversation instead.
 */
export function selectCollaborationWorktreeKeys(
  sessions: WorkspaceSessions,
  serverIds: readonly string[],
): string[] {
  const keys: string[] = [];
  for (const serverId of serverIds) {
    for (const workspace of sessions[serverId]?.workspaces.values() ?? []) {
      if (isCollaborationWorktree(workspace)) keys.push(`${serverId}:${workspace.id}`);
    }
  }
  return keys;
}

export function hideSidebarWorkspaces<T extends Pick<WorkspaceStructureProject, "workspaceKeys">>(
  projects: T[],
  hiddenKeys: readonly string[],
): T[] {
  if (hiddenKeys.length === 0) return projects;
  const hidden = new Set(hiddenKeys);
  return projects.map((project) =>
    project.workspaceKeys.some((key) => hidden.has(key))
      ? { ...project, workspaceKeys: project.workspaceKeys.filter((key) => !hidden.has(key)) }
      : project,
  );
}
