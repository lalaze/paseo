import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { composerLocator } from "../support/helpers/composer";
import { openCommandCenter } from "../support/helpers/command-center";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

test.use({ e2eInjectPaseoTools: true });

async function chooseModel(page: Page, role: "director" | "worker" | "reviewer") {
  await page.getByTestId(`collaboration-${role}-provider`).click();
  await page.getByTestId("collaboration-provider-option-mock").filter({ visible: true }).click();
  await page.getByTestId(`collaboration-${role}-model`).click();
  await page
    .getByTestId("collaboration-model-option-ten-second-stream")
    .filter({ visible: true })
    .click();
}

test("open empty collaboration history directly and return to its host settings", async ({
  page,
}) => {
  await page.goto(`/settings/hosts/${getServerId()}/collaboration/history`, {
    waitUntil: "commit",
  });
  await expect(
    page.getByText("No collaboration conversations yet.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("settings-detail-header-title")).toHaveText("Conversation history");
  await page.getByTestId("collaboration-history-back").click();
  await expect(page).toHaveURL(/\/collaboration$/);
  await expect(page.getByTestId("collaboration-open-history")).toBeVisible();
  await expect(page.getByTestId("collaboration-history")).toHaveCount(0);
});

test("save prompts without agent profiles and keep conflicting edits visible", async ({ page }) => {
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-prompts",
  });
  try {
    await page.goto(`/settings/hosts/${getServerId()}/collaboration`);
    await expect(page.getByTestId("collaboration-role-workerProfileId")).toHaveCount(0);
    await expect(page.getByLabel("Maximum operations per round", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Agent profiles", { exact: true })).toHaveCount(0);
    const input = page.getByLabel("Implementation instructions", { exact: true });
    await input.fill("Read docs before editing");
    const before = await client.collaborationCommand("status");
    await client.collaborationCommand("prompts.save", {
      prompts: { execute: "Changed elsewhere" },
      base: before.rolePrompts,
    });
    const save = page.getByRole("button", { name: "Save collaboration settings", exact: true });
    await save.click();
    await expect(page.getByRole("alert")).toContainText("提示词已在其他设备修改");
    await expect(input).toHaveValue("Read docs before editing");
    await expect(save).toBeEnabled();
    await page.reload();
    await expect(input).toHaveValue("Changed elsewhere");
    await input.fill("Read docs before editing");
    await save.click();
    await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
    const after = await client.collaborationCommand("status");
    expect(after.settings).toBeNull();
    expect(after.rolePrompts).toEqual({ execute: "Read docs before editing" });
  } finally {
    await client.close();
  }
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`start collaboration from a new chat with inline models on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "collaboration-draft-" });
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "collaboration-draft",
    });
    try {
      const before = await client.collaborationCommand("status");
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const draft = "Keep this unsent draft";
      await composerLocator(page).fill(draft);
      const control = page.getByTestId("composer-collaboration").filter({ visible: true });
      await control.click();
      await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
      await page.getByTestId("collaboration-launch-cancel").click();
      await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
      await expect(composerLocator(page)).toHaveValue(draft);
      expect((await client.collaborationCommand("status")).conversations).toHaveLength(
        before.conversations.length,
      );
      await composerLocator(page).fill("");
      await control.click();
      await page.getByTestId("collaboration-mode-execute-review").click();
      await expect(page.getByTestId("collaboration-director-provider")).toHaveCount(0);
      await chooseModel(page, "worker");
      await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
      await chooseModel(page, "reviewer");
      await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
      await page.getByTestId("collaboration-continue").click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`inline-models-${viewport.name}.png`) });
      await page.getByTestId("collaboration-continue").click();
      await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
      const after = await client.collaborationCommand("status");
      const created = after.conversations.filter(
        (entry) => !before.conversations.some((old) => old.id === entry.id),
      );
      expect(created).toHaveLength(1);
      expect(created[0].workspaceId).toBe(workspace.workspaceId);
      expect(created[0].mode).toBe("execute_review");
      expect(created[0].run).toBeUndefined();
      expect(created[0].settings?.workerProfileId).toBe("worker");
      expect(created[0].settings?.reviewerProfileId).toBe("reviewer");
      expect(created[0].settings?.profiles.map((profile) => profile.provider)).toEqual([
        "mock/ten-second-stream",
        "mock/ten-second-stream",
      ]);
      await expect(composerLocator(page)).toBeVisible();
    } finally {
      await client.close();
      await workspace.cleanup();
    }
  });
}

test("preserve inline models and slash-command goal through prompt settings, then launch full workflow from the palette", async ({
  page,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "collaboration-picker-",
    title: "Picker entry points",
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-picker",
  });
  try {
    const before = await client.collaborationCommand("status");
    await openAgentRoute(page, session);
    const chatUrl = page.url();
    const goal = "Review keyboard navigation and preserve the current layout";
    await composerLocator(page).fill(`/director ${goal}`);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByTestId("collaboration-launch-goal")).toBeVisible();
    await expect(page.getByTestId("collaboration-director-provider")).toHaveCount(0);
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-mode-execute-review").click();
    await chooseModel(page, "reviewer");
    await page.getByTestId("collaboration-manage-prompts").click();
    await page.getByLabel("Review instructions", { exact: true }).fill("Check behavior and tests");
    await page.getByRole("button", { name: "Save collaboration settings", exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-launch-goal")).toContainText(goal);
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("collaboration-worker-model")).toContainText("Ten second stream");
    await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
    await page.getByTestId("collaboration-launch-cancel").click();
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );
    const palette = await openCommandCenter(page);
    await palette.getByTestId("command-center-input").fill("collaboration");
    await palette.getByText("New collaboration conversation", { exact: true }).click();
    await chooseModel(page, "director");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const after = await client.collaborationCommand("status");
    const created = after.conversations.filter(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    );
    expect(created).toHaveLength(1);
    expect(created[0].mode).toBe("full");
    expect(created[0].agentId).not.toBe(session.agentId);
    expect(created[0].settings?.rolePrompts?.review).toBe("Check behavior and tests");
    expect(created[0].run).toBeUndefined();
  } finally {
    await client.close();
    await session.cleanup();
  }
});

test("conversation history truncates long goals and keeps details and actions accessible on desktop and phone", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "collaboration-history-",
    title: "History layout",
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-history",
  });
  const goal =
    "Improve the mobile video experience: make playback, page navigation, subtitles, and touch controls feel natural. Read the existing implementation, preserve authentication and cookies, keep proxy and AI features opt-in, and verify the changes on Android and desktop. Document the checks and let the user accept the final result. Do not publish or push any changes.";
  try {
    const before = await client.collaborationCommand("status");
    if (!before.settings) {
      await client.collaborationCommand("settings.save", {
        base: null,
        settings: {
          profiles: [
            {
              id: "collaboration-test",
              label: "Collaboration test agent",
              provider: "mock/e2e-fast-stream",
              modeId: "load-test",
            },
          ],
          directorProfileId: "collaboration-test",
          workerProfileId: "collaboration-test",
        },
      });
    }
    const state = await client.collaborationCommand("conversation.open", {
      requestId: `history-${session.agentId}`,
      workspaceId: session.workspaceId,
      fresh: true,
      goal,
    });
    const conversation = state.conversations.find(
      (entry) => entry.requestId === `history-${session.agentId}`,
    );
    expect(conversation).toBeDefined();
    await page.goto(`/settings/hosts/${getServerId()}/collaboration`, { waitUntil: "commit" });
    await page.getByTestId("collaboration-open-history").click();
    await expect(page).toHaveURL(/\/collaboration\/history$/);
    await page.getByTestId("collaboration-history-back").click();
    await expect(page).toHaveURL(/\/collaboration$/);
    await expect(page.getByTestId("collaboration-history")).toHaveCount(0);
    await page.getByTestId("collaboration-open-history").click();
    const row = page.getByTestId(`collaboration-history-${conversation!.id}`);
    const title = row.getByTestId("collaboration-history-title");
    await row.scrollIntoViewIfNeeded();
    await expect(title).toHaveText(goal);
    await expect(title).toHaveCSS("-webkit-line-clamp", "2");
    await expect(row.getByText("Tasks 0/0", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("history-desktop.png") });
    await row.getByTestId("collaboration-history-actions").click();
    await expect(page.getByRole("menuitem", { name: "Resync", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("history-desktop-menu.png") });
    await page.getByRole("menuitem", { name: "Show details", exact: true }).click();
    await expect(title).not.toHaveCSS("-webkit-line-clamp", "2");
    await row.getByTestId("collaboration-history-actions").click();
    await page.getByRole("menuitem", { name: "Hide details", exact: true }).click();
    await expect(title).toHaveCSS("-webkit-line-clamp", "2");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/settings/hosts/${getServerId()}/collaboration/history`, {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("collaboration-history-page")).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/collaboration$/);
    await page.getByTestId("collaboration-open-history").click();
    await row.scrollIntoViewIfNeeded();
    const bounds = await row.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("history-phone.png") });
    await row.getByTestId("collaboration-history-actions").click();
    await expect(page.getByRole("menuitem", { name: "Show details", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Resync", exact: true }).click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath("history-phone-menu.png") });
    await page.getByRole("menuitem", { name: "Resync", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Resync", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "Open conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace\//);
  } finally {
    await client.close();
    await session.cleanup();
  }
});
