import { test, expect } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  hideSidebarWorkspaces,
  isCollaborationWorktree,
  selectCollaborationWorktreeKeys,
} from "./sidebar-worktrees";

const runId = "bbf6ddcaa4c1609a4dde0123";

function workspace(id: string, worktreeSlug?: string): WorkspaceDescriptor {
  return { id, worktreeSlug } as WorkspaceDescriptor;
}

test("recognizes only the worktree a collaboration task creates", () => {
  expect(isCollaborationWorktree({ worktreeSlug: `director-${runId}` })).toBe(true);
  expect(isCollaborationWorktree({ worktreeSlug: "director-notes" })).toBe(false);
  expect(isCollaborationWorktree({ worktreeSlug: "feature-auth" })).toBe(false);
  expect(isCollaborationWorktree({ worktreeSlug: undefined })).toBe(false);
});

test("hides collaboration worktrees from the sidebar and keeps the rest in order", () => {
  const sessions = {
    host: {
      workspaces: new Map([
        ["main", workspace("main")],
        ["task", workspace("task", `director-${runId}`)],
        ["feature", workspace("feature", "feature-auth")],
      ]),
    },
  };
  const hidden = selectCollaborationWorktreeKeys(sessions, ["host", "offline"]);
  expect(hidden).toEqual(["host:task"]);

  const untouched = { viewKey: "other", workspaceKeys: ["host:other"] };
  const projects = hideSidebarWorkspaces(
    [{ viewKey: "game", workspaceKeys: ["host:main", "host:task", "host:feature"] }, untouched],
    hidden,
  );
  expect(projects).toEqual([
    { viewKey: "game", workspaceKeys: ["host:main", "host:feature"] },
    untouched,
  ]);
  expect(projects[1]).toBe(untouched);
});
