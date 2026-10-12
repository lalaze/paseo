import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
} from "../support/helpers/archive-tab";
import {
  createAgentTabFromMenu,
  expectOnlyWorkspaceAgentTabsVisible,
  openChangesPanel,
} from "../support/helpers/workspace-tabs";
import {
  seedWorkspace,
  type SeedDaemonClient,
  type SeededWorkspace,
} from "../support/helpers/seed-client";
import {
  expectSubagentRowVisible,
  openSubagentsTrack,
  seedParentWithCrossCheckoutSubagent,
  type SeededCrossCheckoutSubagentPair,
} from "../support/helpers/subagents";

const MAIN_DIFF_MARKER_FILE = "main-checkout-only-marker.txt";

const REPLACEMENT_PROMPT = "Replacement prompt after slash clear.";

async function runClientSlashCommand(page: Page, command: string): Promise<void> {
  const input = composerLocator(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(command);
  await expect(input).toHaveValue(command);
  await input.press("Enter");
}

/**
 * Opens the worker from the parent's subagents track. The track closes itself when a row navigates
 * away, so this is also how a spec reopens it for a repeat click.
 */
async function openWorkerFromParent(page: Page, parentId: string, childId: string): Promise<void> {
  await page.getByTestId(`workspace-tab-agent_${parentId}`).click();
  await openSubagentsTrack(page);
  await expectSubagentRowVisible(page, childId);
  await page.getByTestId(`subagents-track-row-${childId}`).click();
  await expectWorkspaceTabVisible(page, childId);
}

/** The daemon's view of the agent that replaced `previousAgentId` inside `workspaceId`. */
async function waitForReplacementAgent(
  client: SeedDaemonClient,
  input: { workspaceId: string; previousAgentId: string },
): Promise<{ id: string; workspaceId?: string; cwd: string }> {
  let replacement: { id: string; workspaceId?: string; cwd: string } | null = null;
  await expect
    .poll(
      async () => {
        const { entries } = await client.fetchAgents({ scope: "active" });
        replacement =
          entries.find(
            (entry) =>
              entry.agent.workspaceId === input.workspaceId &&
              entry.agent.id !== input.previousAgentId,
          )?.agent ?? null;
        return replacement?.id ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  if (!replacement) {
    throw new Error("The replacement agent was not created.");
  }
  return replacement;
}

/** Adds one review comment on the first changed line of the Changes diff already on screen. */
async function addReviewCommentOnFirstChangedLine(page: Page, body: string): Promise<void> {
  const [bodyBounds, fontSize] = await Promise.all([
    page.getByTestId("diff-file-0-body").boundingBox(),
    page
      .getByTestId("git-diff-canvas")
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) {
    throw new Error("Expanded diff body has no bounds");
  }
  await page.mouse.move(bodyBounds.x + 20, bodyBounds.y + Math.round(fontSize * 1.5) * 1.5);
  await page.getByRole("button", { name: "Add review comment" }).click();
  const editor = page.getByTestId("inline-review-editor-input");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.fill(body);
  await page.getByTestId("inline-review-editor-save").click();
  await expect(page.getByText(body, { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe("Cross-workspace subagent open", () => {
  let main: SeededWorkspace | undefined;
  let pair: SeededCrossCheckoutSubagentPair | undefined;

  test.beforeEach(async () => {
    main = await seedWorkspace({ repoPrefix: "subagent-cross-workspace-" });
    pair = await seedParentWithCrossCheckoutSubagent(main, {
      parentTitle: "Main parent",
      childTitle: "Cross-workspace worker",
    });
  });

  test.afterEach(async () => {
    await pair?.cleanup();
    await main?.cleanup();
  });

  test("opens a worker from another workspace in the current workspace tab bar", async ({
    page,
  }) => {
    const parent = pair!.parent;
    const child = pair!.child;
    await openAgentRoute(page, { workspaceId: main!.workspaceId, agentId: parent.id });
    await expectWorkspaceTabVisible(page, parent.id);
    const parentUrl = page.url();

    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, child.id);
    await page.getByTestId(`subagents-track-row-${child.id}`).click();

    // The worker's conversation opens where the user is reading. Its own worktree stays put.
    await expectWorkspaceTabVisible(page, child.id);
    expect(page.url()).toBe(parentUrl);
    await expectOnlyWorkspaceAgentTabsVisible(page, [parent.id, child.id]);

    // Reopening from the parent reuses the tab instead of adding a second one.
    await openWorkerFromParent(page, parent.id, child.id);
    await expect(page.getByTestId(`workspace-tab-agent_${child.id}`)).toHaveCount(1);

    // Reconcile prunes agent tabs whose agent is not active in the workspace. The worker runs in
    // another workspace, so only the explicit-open pin keeps its tab. Reload rehydrates the layout
    // from storage and reconciles from scratch — the strongest form of this check.
    await page.reload();
    await expectWorkspaceTabVisible(page, child.id);
    await expectWorkspaceTabVisible(page, parent.id);
    expect(page.url()).toBe(parentUrl);
  });

  test("a /clear on a worker keeps the worker's own execution directory", async ({ page }) => {
    const parent = pair!.parent;
    const child = pair!.child;
    await openAgentRoute(page, { workspaceId: main!.workspaceId, agentId: parent.id });
    await openWorkerFromParent(page, parent.id, child.id);
    const workerUrl = page.url();

    await runClientSlashCommand(page, "/clear");

    // The visible tab becomes a fresh draft in the workspace on screen.
    await expectWorkspaceTabHidden(page, child.id);
    await expectComposerVisible(page);
    expect(page.url()).toBe(workerUrl);
    await expect(
      page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true }),
    ).toHaveCount(1);

    await submitMessage(page, REPLACEMENT_PROMPT);

    // The daemon created the replacement in the worker's own workspace and checkout, not the
    // pane's. This is the regression: the draft must carry the worker's runtime workspace.
    const replacement = await waitForReplacementAgent(main!.client, {
      workspaceId: child.workspaceId,
      previousAgentId: child.id,
    });
    expect(replacement.workspaceId).toBe(child.workspaceId);
    expect(replacement.cwd).toBe(child.cwd);

    // The pane keeps the replacement conversation on screen even though it runs elsewhere.
    await expectWorkspaceTabVisible(page, replacement.id);
    expect(page.url()).toBe(workerUrl);
  });

  test("a /exit on a worker clears the visible tab and leaves the parent alone", async ({
    page,
  }) => {
    const parent = pair!.parent;
    const child = pair!.child;
    await openAgentRoute(page, { workspaceId: main!.workspaceId, agentId: parent.id });
    await openWorkerFromParent(page, parent.id, child.id);

    await runClientSlashCommand(page, "/quit");

    // The tab that closes is the one in the workspace on screen, and the parent is untouched.
    await expectWorkspaceTabHidden(page, child.id);
    await expectWorkspaceTabVisible(page, parent.id);
    await expectOnlyWorkspaceAgentTabsVisible(page, [parent.id]);
  });

  test("a draft's review attachment opens the workspace's own diff", async ({ page }) => {
    const parent = pair!.parent;

    await writeFile(
      path.join(main!.repoPath, MAIN_DIFF_MARKER_FILE),
      "main checkout only marker\n",
      "utf8",
    );
    await main!.client.checkoutRefresh(main!.repoPath);

    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, { workspaceId: main!.workspaceId, agentId: parent.id });
    await expectWorkspaceTabVisible(page, parent.id);

    // Review the checkout this workspace shows. The Changes panel stays mounted, so the review
    // remains on the workspace attachment scope the draft reads.
    await openChangesPanel(page);
    await addReviewCommentOnFirstChangedLine(page, "Main checkout review");

    // Open a fresh draft in the same workspace while the Changes view stays mounted.
    await createAgentTabFromMenu(page);
    await expect(
      page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true }),
    ).toHaveCount(1, { timeout: 15_000 });

    const draftTab = page
      .locator('[data-testid^="workspace-tab-draft_"]')
      .filter({ visible: true });
    await expect(draftTab).toHaveAttribute("aria-selected", "true");

    const pill = page.getByTestId("composer-review-attachment-pill").filter({ visible: true });
    await expect(pill).toHaveCount(1, { timeout: 15_000 });
    await pill.click();

    // The click runs the real callback: it hands focus to the workspace's diff, so the draft tab
    // loses selection. Without that the click would be a no-op and the assertions below would
    // pass on the already-mounted Changes view.
    await expect(draftTab).not.toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

    // The diff shown is this workspace's checkout. The cross-workspace variant (a worker's draft
    // shown in the main workspace) cannot be driven here: the review attachment lives only while
    // the diff pane that made it is mounted, and a worker's pane is unmounted whenever the main
    // workspace is on screen. That branch is pinned by `composer/draft/review-open.test.ts`.
    const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator(`[data-diff-header-path="${MAIN_DIFF_MARKER_FILE}"]`)).toBeVisible({
      timeout: 30_000,
    });
  });
});
