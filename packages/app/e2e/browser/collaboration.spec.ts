import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { submitMessage, composerLocator } from "../support/helpers/composer";

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

test("configure native collaboration, retain invalid edits, and enable it in the current chat", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "native-collaboration-",
    title: "Native collaboration",
  });
  try {
    await openAgentRoute(page, session);
    await submitMessage(page, "/director");
    await expect(composerLocator(page)).toHaveValue("/director ");
    await composerLocator(page).press("Enter");
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
    await expect(page).toHaveURL(/\/workspace\//);
    await expect(page.getByText("Collaboration enabled", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("collaboration-chat.png"), fullPage: true });
    await page.goto(`/settings/hosts/${getServerId()}/collaboration`, { waitUntil: "commit" });
    await expect(page.getByText("Collaboration conversations", { exact: true })).toBeVisible();
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
