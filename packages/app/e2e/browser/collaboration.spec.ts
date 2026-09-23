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
      "aria-checked",
      "true",
    );
    await page.getByTestId("collaboration-mode-execute-review").click();
    await expect(page.getByTestId("collaboration-launch-reviewer")).toContainText("Not configured");
    await expect(page.getByTestId("collaboration-continue")).toHaveCount(0);
    await expect(page.getByTestId("collaboration-configure")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("reviewer-missing-desktop.png") });
    await page.getByTestId("collaboration-configure").click();
    await expect(page).toHaveURL(/\/collaboration$/);
    await page.getByTestId("collaboration-role-reviewerProfileId").click();
    await page
      .getByRole("button", { name: /Collaboration test agent/ })
      .last()
      .click();
    await page.getByRole("button", { name: "Save collaboration settings", exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-checked",
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
      "aria-checked",
      "true",
    );
    await page.getByTestId("collaboration-continue").click({ trial: true });
    await page.screenshot({
      path: testInfo.outputPath("execution-review-phone.png"),
    });
    await page.getByTestId("collaboration-manage-profiles").click();
    await expect(page).toHaveURL(/\/collaboration$/);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-checked",
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
    await expect(page.getByTestId("collaboration-launch-goal")).toBeVisible();
    await page.getByTestId("collaboration-mode-execute-review").click();
    await page.getByTestId("collaboration-manage-profiles").click();
    await page
      .getByTestId("settings-detail-pane")
      .getByRole("button", { name: "Continue to conversation", exact: true })
      .click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-launch-goal")).toBeVisible();
    await expect(page.getByTestId("collaboration-mode-execute-review")).toHaveAttribute(
      "aria-checked",
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
      "aria-checked",
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

for (const theme of ["dark", "light", "skin"] as const) {
  test(`mode picker visual states and keyboard navigation in ${theme}`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(
      (appearance) => {
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ theme: appearance, language: "zh-CN" }),
        );
      },
      theme === "skin" ? "dark" : theme,
    );
    const session = await seedMockAgentWorkspace({
      repoPrefix: "picker-design-",
      title: "协作弹窗",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "picker-design" });
    const saveProfiles = async (label: string, review: boolean) => {
      const current = await client.collaborationCommand("status");
      await client.collaborationCommand("settings.save", {
        base: current.settings,
        settings: {
          profiles: [
            {
              id: "collaboration-test",
              label,
              provider: "mock/e2e-fast-stream",
              modeId: "load-test",
            },
          ],
          directorProfileId: "collaboration-test",
          workerProfileId: "collaboration-test",
          reviewerProfileId: review ? "collaboration-test" : undefined,
        },
      });
    };
    try {
      await saveProfiles("执行 AI", false);
      if (theme === "skin") {
        const { strToU8, zipSync } = await import("fflate");
        const { readFile } = await import("node:fs/promises");
        await page.goto("/settings/appearance");
        const buffer = process.env.PASEO_SKIN_QA_ZIP
          ? await readFile(process.env.PASEO_SKIN_QA_ZIP)
          : Buffer.from(
              zipSync({
                "theme.json": strToU8(
                  JSON.stringify({
                    schemaVersion: 1,
                    id: "picker-qa",
                    name: "Picker QA",
                    image: "background.png",
                    appearance: "dark",
                    colors: {
                      background: "#0d0d0e",
                      panel: "#171513",
                      panelAlt: "#211d18",
                      accent: "#c8a55a",
                      accentAlt: "#e3c27a",
                      text: "#f3ead7",
                      muted: "#b5a386",
                      line: "rgba(200,165,90,.28)",
                    },
                  }),
                ),
                "background.png": await readFile("assets/images/icon.png"),
              }),
            );
        await page
          .getByTestId("skin-file-input")
          .setInputFiles({ name: "picker-qa.zip", mimeType: "application/zip", buffer });
        await expect(page.getByTestId("skin-background")).toBeVisible();
      }
      await openAgentRoute(page, session);
      await page.getByTestId("composer-collaboration").click();
      const full = page.getByTestId("collaboration-mode-full");
      const light = page.getByTestId("collaboration-mode-execute-review");
      await expect(full).toHaveAttribute("role", "radio");
      await full.focus();
      await page.keyboard.press("ArrowDown");
      await expect(light).toHaveAttribute("aria-checked", "true");
      await expect(light).toBeFocused();
      await expect(light).toHaveCSS("outline-width", "2px");
      await full.focus();
      await page.keyboard.press("Space");
      await expect(full).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("ArrowRight");
      await expect(light).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Home");
      await expect(full).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("End");
      await expect(light).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("collaboration-manage-profiles")).toBeFocused();
      await page.getByTestId("collaboration-configure").focus();
      await expect(page.getByTestId("collaboration-configure")).toHaveText("配置审核 Agent");
      await page.mouse.move(10, 10);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-missing-desktop.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("collaboration-configure").click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-missing-phone.png`) });
      for (const element of [
        full,
        light,
        page.getByTestId("collaboration-configure"),
        page.getByTestId("collaboration-launch-cancel"),
      ]) {
        expect((await element.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.getByTestId("collaboration-launch-cancel").click();
      const label = "协作执行与独立审核 · 长配置名称与跨平台验证 · GPT-6 多语言和键盘交互检查";
      await saveProfiles(label, true);
      const goal =
        "检查桌面和手机的协作流程，保留现有目标和原会话。验证模式选择、配置返回、取消、失败重试与键盘导航。请完整记录测试结果。".repeat(
          8,
        );
      await page
        .getByRole("textbox", { name: "给 Agent 发消息...", exact: true })
        .fill(`/director ${goal}`);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.getByTestId("collaboration-launch-worker")).toContainText(label);
      const toggle = page.getByTestId("collaboration-goal-toggle");
      await expect(toggle).toBeVisible();
      await expect(page.getByTestId("collaboration-launch-goal")).toHaveCSS(
        "-webkit-line-clamp",
        "3",
      );
      await page.getByTestId("collaboration-continue").click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-long-phone.png`) });
      await page.getByTestId("collaboration-launch-reviewer").scrollIntoViewIfNeeded();
      await page.getByTestId("collaboration-continue").click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-long-profiles-phone.png`) });
      await toggle.scrollIntoViewIfNeeded();
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.getByTestId("collaboration-continue").click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-expanded-phone.png`) });
      await page.setViewportSize({ width: 320, height: 640 });
      await page.getByTestId("collaboration-continue").click({ trial: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        320,
      );
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.getByTestId("collaboration-continue").click({ trial: true, timeout: 10_000 });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-long-desktop.png`) });
      await page.getByTestId("collaboration-launch-reviewer").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${theme}-long-profiles-desktop.png`) });
      await page.getByTestId("collaboration-launch-cancel").click();
      expect(errors).toEqual([]);
    } finally {
      await client.close();
      await session.cleanup();
    }
  });
}
