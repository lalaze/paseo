import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { composerLocator } from "../support/helpers/composer";
import { openCommandCenter } from "../support/helpers/command-center";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

test.use({
  e2eInjectPaseoTools: true,
  e2eDaemonConfig: {
    version: 1,
    daemon: {
      agentProfiles: [
        {
          id: "collaboration-test",
          name: "Collaboration test agent",
          provider: "mock",
          model: "e2e-fast-stream",
          modeId: "load-test",
        },
      ],
    },
  },
});

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

test("configure native collaboration, retain invalid edits, and enable it in the current chat", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "native-collaboration-",
    title: "Native collaboration",
  });
  try {
    await openAgentRoute(page, session);
    const chatUrl = page.url();
    await composerLocator(page).fill("/director");
    await page.screenshot({ path: testInfo.outputPath("collaboration-entry.png") });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toBeVisible();
    await expect(page).toHaveURL(chatUrl);
    await page.getByRole("button", { name: "Configure agents", exact: true }).click();
    await expect(page.getByText("Lead agent", { exact: true })).toBeVisible();
    const save = page.getByRole("button", { name: "Save collaboration settings", exact: true });
    await expect(save).toBeVisible();
    const attempts = page.getByLabel("Maximum operations per round", { exact: true });
    await attempts.fill("0");
    await save.click();
    await expect(page.getByText(/Too small|greater than|>=3/).first()).toBeVisible();
    await expect(attempts).toHaveValue("0");
    await attempts.fill("40");
    await save.click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("full-workflow.png") });
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/workspace\//);
    await expect(page.getByText("Collaboration enabled", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("collaboration-chat.png"), fullPage: true });
    await page.goto(`/settings/hosts/${getServerId()}/collaboration`, { waitUntil: "commit" });
    await expect(page.getByTestId("collaboration-history")).toHaveCount(0);
    await page.getByTestId("collaboration-open-history").click();
    await expect(page).toHaveURL(/\/collaboration\/history$/);
    await expect(
      page.getByRole("button", { name: "Save collaboration settings", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Open conversation", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("collaboration-settings.png"),
      fullPage: true,
    });
  } finally {
    await session.cleanup();
  }
});

test("choose execution-review, configure its reviewer, cancel, and enable without starting a task", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "light-collaboration-",
    title: "Light collaboration",
  });
  try {
    await openAgentRoute(page, session);
    const chatUrl = page.url();
    await composerLocator(page).fill("Keep this draft while choosing collaboration");
    await page.getByTestId("composer-collaboration").click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-mode-full")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId("collaboration-mode-execute-review").click();
    await expect(
      page.getByText("Choose an independent review agent in collaboration settings."),
    ).toBeVisible();
    await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
    await page.getByRole("button", { name: "Configure agents", exact: true }).click();
    await expect(page).toHaveURL(/\/collaboration$/);
    await page.getByTestId("collaboration-role-reviewerProfileId").click();
    await page
      .getByRole("button", { name: /Collaboration test agent/ })
      .last()
      .click();
    await page.getByRole("button", { name: "Save collaboration settings", exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("execution-review-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("collaboration-continue")).toBeVisible();
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId("collaboration-continue").click({ trial: true });
    await page.screenshot({
      path: testInfo.outputPath("execution-review-phone.png"),
    });
    await page.getByRole("button", { name: "Configure agents", exact: true }).click();
    await expect(page).toHaveURL(/\/collaboration$/);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue("Keep this draft while choosing collaboration");
    await expect(page).toHaveURL(/\/workspace\//);
    await expect(page.getByText("Collaboration enabled", { exact: true })).toHaveCount(0);
    await composerLocator(page).fill("/director");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByTestId("collaboration-mode-execute-review").click();
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect(page.getByText("Collaboration enabled", { exact: true })).toBeVisible();
    await page.goto(`/settings/hosts/${getServerId()}/collaboration`, { waitUntil: "commit" });
    await page.getByTestId("collaboration-open-history").click();
    await expect(page.getByText("Execution + review", { exact: true })).toBeVisible();
  } finally {
    await session.cleanup();
  }
});

test("collaboration settings remain usable on a phone viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/settings/hosts/${getServerId()}/collaboration`, { waitUntil: "commit" });
  await expect(page.getByText("Lead agent", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Maximum operations per round", { exact: true })).toBeEditable();
  const save = page.getByRole("button", { name: "Save collaboration settings", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("collaboration-mobile.png"), fullPage: true });
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

test("keep a slash-command goal through configuration and create a new conversation from the same picker", async ({
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
          reviewerProfileId: "collaboration-test",
        },
      });
    }
    await openAgentRoute(page, session);
    const chatUrl = page.url();
    const goal = "Review keyboard navigation and preserve the current layout";
    await composerLocator(page).fill(`/director ${goal}`);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText(goal, { exact: true })).toBeVisible();
    await page.getByTestId("collaboration-mode-execute-review").click();
    await page.getByRole("button", { name: "Configure agents", exact: true }).click();
    await page
      .getByTestId("settings-detail-pane")
      .getByRole("button", { name: "Continue to conversation", exact: true })
      .click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByText(goal, { exact: true })).toBeVisible();
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );

    const palette = await openCommandCenter(page);
    await palette.getByTestId("command-center-input").fill("collaboration");
    await palette.getByText("New collaboration conversation", { exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-mode-full")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const after = await client.collaborationCommand("status");
    const created = after.conversations.filter(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    );
    expect(created).toHaveLength(1);
    expect(created[0].workspaceId).toBe(session.workspaceId);
    expect(created[0].agentId).not.toBe(session.agentId);
    expect(created[0].mode).toBe("full");
    expect(created[0].run).toBeUndefined();
  } finally {
    await client.close();
    await session.cleanup();
  }
});
