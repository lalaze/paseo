import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY } from "@/stores/sidebar-view-store";
import { i18n } from "@/i18n/i18next";
import { filterWorkspacesByLabels, labelWorkspaceGroups } from "./sidebar-labels";

function getWorkspaceId(entry: SidebarWorkspaceEntry): string {
  return entry.workspaceId;
}

function workspace(
  workspaceId: string,
  labels: string[],
  pinnedAt: string | null = null,
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: "project",
    projectName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt,
    labels,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

describe("sidebar label filtering", () => {
  const workspaces = [
    workspace("one", ["Backend", "Urgent"], "2026-01-01"),
    workspace("two", ["Backend"]),
    workspace("three", []),
  ];

  function filtered(labels: string[]) {
    return filterWorkspacesByLabels({ workspaces, labels }).map((entry) => entry.workspaceId);
  }

  test("includes a workspace carrying any selected label", () => {
    expect(filtered([])).toEqual(["one", "two", "three"]);
    expect(filtered(["backend"])).toEqual(["one", "two"]);
    expect(filtered(["backend", "urgent"])).toEqual(["one", "two"]);
  });

  test("models Unlabelled as a row in the same list", () => {
    expect(filtered([SIDEBAR_UNLABELLED_LABEL_KEY])).toEqual(["three"]);
    expect(filtered(["backend", SIDEBAR_UNLABELLED_LABEL_KEY])).toEqual(["one", "two", "three"]);
  });

  test("reads whitespace-only label names as no label rather than as the Unlabelled key", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces: [workspace("blank", ["   "])],
        labels: [SIDEBAR_UNLABELLED_LABEL_KEY],
      }).map((entry) => entry.workspaceId),
    ).toEqual(["blank"]);
  });
});

describe("sidebar label grouping", () => {
  test("groups by normalized labels with running workspaces first and Unlabelled last", () => {
    const done = workspace("done", ["Backend", "Urgent"]);
    done.statusEnteredAt = new Date("2026-10-19T12:00:00Z");
    const running = workspace("running", [" backend ", "BACKEND"]);
    running.statusBucket = "running";
    running.statusEnteredAt = new Date("2026-10-18T12:00:00Z");
    const groups = labelWorkspaceGroups([done, workspace("blank", [" "]), running], i18n.t);

    expect(
      groups.map((group) => ({
        label: group.label,
        ids: group.rows.map(getWorkspaceId),
      })),
    ).toEqual([
      { label: "Backend", ids: ["running", "done"] },
      { label: "Urgent", ids: ["done"] },
      { label: "Unlabelled", ids: ["blank"] },
    ]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(3);
  });
});
