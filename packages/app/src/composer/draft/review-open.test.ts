import { describe, expect, it } from "vitest";
import { planDraftReviewOpen } from "@/composer/draft/review-open";

const SERVER_ID = "server-1";
const MAIN_WORKSPACE_ID = "ws-main";
const WORKER_WORKSPACE_ID = "ws-worker";
const MAIN_WORKSPACE_KEY = `${SERVER_ID}:${MAIN_WORKSPACE_ID}`;
const WORKER_WORKSPACE_KEY = `${SERVER_ID}:${WORKER_WORKSPACE_ID}`;
const WORKER_CWD = "/worktrees/worker";

describe("planDraftReviewOpen", () => {
  it("takes the user to the runtime workspace when a cross-workspace draft would open in a pane", () => {
    // A worker's draft shown in the main workspace: the desktop pane would add a diff tab to the
    // main layout, which is invisible and shows the wrong checkout. Navigate instead.
    expect(
      planDraftReviewOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        runtimeWorkspaceId: WORKER_WORKSPACE_ID,
        cwd: WORKER_CWD,
        opensInPane: true,
      }),
    ).toEqual({ kind: "navigate", workspaceId: WORKER_WORKSPACE_ID });
  });

  it("keeps the compact cross-workspace view pointed at the worker's own checkout", () => {
    // The compact explorer is checkout-based, so it needs the worker's key and cwd, not the
    // pane's. Swapping only the key would point the visible panel at the wrong directory.
    expect(
      planDraftReviewOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        runtimeWorkspaceId: WORKER_WORKSPACE_ID,
        cwd: WORKER_CWD,
        opensInPane: false,
      }),
    ).toEqual({
      kind: "open",
      workspaceKey: WORKER_WORKSPACE_KEY,
      checkoutCwd: WORKER_CWD,
    });
  });

  it("opens in the pane when the draft runs in the workspace it is shown in", () => {
    expect(
      planDraftReviewOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        runtimeWorkspaceId: MAIN_WORKSPACE_ID,
        cwd: "/worktrees/main",
        opensInPane: true,
      }),
    ).toEqual({ kind: "open", workspaceKey: MAIN_WORKSPACE_KEY, checkoutCwd: "/worktrees/main" });
  });

  it("falls back to the display workspace when the draft has no runtime workspace", () => {
    expect(
      planDraftReviewOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        cwd: "/worktrees/main",
        opensInPane: true,
      }),
    ).toEqual({ kind: "open", workspaceKey: MAIN_WORKSPACE_KEY, checkoutCwd: "/worktrees/main" });
  });

  it("treats a blank runtime workspace as the display workspace", () => {
    expect(
      planDraftReviewOpen({
        serverId: SERVER_ID,
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        runtimeWorkspaceId: "   ",
        cwd: "/worktrees/main",
        opensInPane: true,
      }),
    ).toEqual({ kind: "open", workspaceKey: MAIN_WORKSPACE_KEY, checkoutCwd: "/worktrees/main" });
  });

  it("returns null when there is no workspace key to open", () => {
    expect(
      planDraftReviewOpen({
        serverId: "",
        displayWorkspaceId: MAIN_WORKSPACE_ID,
        cwd: "/worktrees/main",
        opensInPane: true,
      }),
    ).toBeNull();
  });
});
