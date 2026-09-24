import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";
import { strToU8, zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openFileExplorer } from "../support/helpers/file-explorer";

test("image skins coordinate conversation surfaces", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ toolCallDetailLevel: "overview" }),
    );
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "skin-conversation-",
    title: "Skin conversation",
    initialPrompt: "Explain how the workspace keeps my coding agents connected.",
    model: "ten-second-stream",
  });
  try {
    await page.goto("/settings");
    await openSettingsSection(page, "appearance");
    const artwork = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 400;
      const context = canvas.getContext("2d")!;
      const gradient = context.createLinearGradient(0, 0, 600, 400);
      gradient.addColorStop(0, "#1d4ed8");
      gradient.addColorStop(1, "#c084fc");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 600, 400);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const buffer = process.env.PASEO_SKIN_QA_ZIP
      ? await readFile(process.env.PASEO_SKIN_QA_ZIP)
      : Buffer.from(
          zipSync({
            "theme.json": strToU8(
              JSON.stringify({
                schemaVersion: 1,
                id: "warm",
                name: "Warm",
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
            "background.png": Buffer.from(artwork, "base64"),
          }),
        );
    await page
      .getByTestId("skin-file-input")
      .setInputFiles({ name: "warm.zip", mimeType: "application/zip", buffer });
    await expect(page.getByTestId("skin-background")).toBeVisible();
    await page.getByRole("button", { name: "65%", exact: true }).click();
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    const tabsRow = page.getByTestId("workspace-pane-main").getByTestId("workspace-tabs-row");
    await expect(tabsRow).toBeVisible();
    const opaqueTabLayers = await tabsRow.evaluate((row) => {
      const opaque: string[] = [];
      let element: Element | null = row;
      while (element && element !== document.body) {
        const color = getComputedStyle(element).backgroundColor;
        if (color.startsWith("rgb(") || color.endsWith(", 1)")) {
          opaque.push(`${element.getAttribute("data-testid") ?? element.className}: ${color}`);
        }
        element = element.parentElement;
      }
      return opaque;
    });
    expect(opaqueTabLayers).toEqual([]);
    await expect(page.getByText("Updating messages", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("assistant-message-surface")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message").first()).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.getByTestId("assistant-message").first()).toHaveCSS(
      "border-top-width",
      "0px",
    );
    await expect(page.getByTestId("assistant-message").first()).toHaveCSS(
      "text-shadow",
      "rgba(0, 0, 0, 0.8) 0px 1px 3px",
    );
    await expect(page.getByTestId("message-input-surface")).toHaveCSS(
      "background-color",
      "rgba(23, 21, 19, 0.74)",
    );
    await expect(page.getByTestId("user-message-surface").first()).toHaveCSS(
      "border-top-width",
      "1px",
    );
    await page.mouse.move(1200, 100);
    await page.screenshot({ path: testInfo.outputPath("skin-conversation.png"), fullPage: true });
    await expect
      .poll(
        async () => {
          const agents = await agent.client.fetchAgents();
          return agents.entries.find((entry) => entry.agent.id === agent.agentId)?.agent.status;
        },
        { timeout: 30_000 },
      )
      .toBe("idle");
    const toolGroup = page.getByTestId("tool-call-group").last();
    await expect(toolGroup).toBeVisible();
    const toolHeading = toolGroup.getByRole("button").first();
    await toolHeading.click();
    await expect(toolGroup.getByTestId("tool-call-badge").first()).toBeVisible();
    await page.mouse.move(1200, 100);
    await expect(toolHeading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(toolGroup).toHaveCSS("text-shadow", "rgba(0, 0, 0, 0.8) 0px 1px 3px");
    await expect(
      toolGroup.getByTestId("tool-call-badge").last().locator('[dir="auto"]').first(),
    ).toHaveCSS("color", "rgb(243, 234, 215)");
    await toolGroup.screenshot({ path: testInfo.outputPath("skin-tools-expanded.png") });
    const shell = toolGroup.getByTestId("tool-call-badge").filter({ hasText: "Shell" });
    const shellHeading = shell.getByRole("button").first();
    await shellHeading.click();
    const output = shell.getByText(/\[burst\] tick 1/);
    await expect(output).toBeVisible();
    await page.mouse.move(1200, 100);
    await shell.screenshot({ path: testInfo.outputPath("skin-shell-output.png") });
    const opaqueOutputLayers = await output.evaluate((text) => {
      const opaque: string[] = [];
      let element: Element | null = text;
      while (element && element.getAttribute("data-testid") !== "tool-call-badge") {
        const color = getComputedStyle(element).backgroundColor;
        if (color.startsWith("rgb(") || color.endsWith(", 1)")) opaque.push(color);
        element = element.parentElement;
      }
      return opaque;
    });
    expect(opaqueOutputLayers).toEqual([]);
    await expect(shellHeading).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await shellHeading.click();
    await expect(output).toHaveCount(0);
    await toolHeading.click();
    await openFileExplorer(page);
    await expect(page.getByTestId("workspace-explorer-sidebar")).toHaveCSS(
      "background-color",
      "rgba(23, 21, 19, 0.5)",
    );
    await expect(page.getByTestId("files-pane-header")).toHaveCSS(
      "background-color",
      "rgba(23, 21, 19, 0.5)",
    );
    await page.mouse.move(600, 100);
    await page.screenshot({ path: testInfo.outputPath("skin-explorer.png"), fullPage: true });
    const opaqueExplorerLayers = await page
      .getByTestId("file-explorer-tree-scroll")
      .evaluate((tree) => {
        const opaque: string[] = [];
        let element: Element | null = tree;
        while (element && element !== document.body) {
          const color = getComputedStyle(element).backgroundColor;
          if (color.startsWith("rgb(") || color.endsWith(", 1)")) {
            opaque.push(`${element.getAttribute("data-testid") ?? element.className}: ${color}`);
          }
          element = element.parentElement;
        }
        return opaque;
      });
    expect(opaqueExplorerLayers).toEqual([]);
    await page.goto("/settings");
    await openSettingsSection(page, "appearance");
    await page.getByRole("button", { name: "Restore default", exact: true }).click();
    await expect(page.getByTestId("skin-background")).toHaveCount(0);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("skin-background")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message").first()).toHaveCSS("text-shadow", "none");
    await expect(tabsRow).toHaveCSS("background-color", /^rgb\(/);
    await expect(page.getByTestId("message-input-surface")).toHaveCSS("backdrop-filter", "none");
    await openFileExplorer(page);
    await expect(page.getByTestId("workspace-explorer-sidebar")).toHaveCSS(
      "background-color",
      /^rgb\(/,
    );
    const defaultGroup = page.getByTestId("tool-call-group").last();
    await defaultGroup.getByRole("button").first().click();
    const defaultShell = defaultGroup.getByTestId("tool-call-badge").filter({ hasText: "Shell" });
    await defaultShell.getByRole("button").first().click();
    await expect(defaultShell.getByTestId("shell-output-surface")).toHaveCSS(
      "background-color",
      /^rgb\(/,
    );
    await expect(defaultShell.getByRole("button").first()).toHaveCSS("border-top-color", /^rgb\(/);
  } finally {
    await agent.cleanup();
  }
});

test("imports, switches and restores image skins without reloading", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  const artwork = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 600, 400);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(1, "#c084fc");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 600, 400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const originalTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  const makePackage = (name: string, appearance: "dark" | "light") =>
    Buffer.from(
      zipSync({
        "theme.json": strToU8(
          JSON.stringify({
            schemaVersion: 1,
            id: name.toLowerCase(),
            name,
            image: "background.png",
            appearance,
            art: { focusX: 0.8 },
          }),
        ),
        "background.png": Buffer.from(artwork, "base64"),
        "theme.css": strToU8("body { display: none !important; }"),
      }),
    );
  await page.getByTestId("skin-file-input").setInputFiles({
    name: "mountain.zip",
    mimeType: "application/zip",
    buffer: makePackage("Mountain", "dark"),
  });
  await expect(page.getByText("Active: Mountain", { exact: true })).toBeVisible();
  const background = page.getByTestId("skin-background");
  await expect(background.locator("img")).toHaveCSS("opacity", "0.3");
  await expect(background.locator("img")).toHaveCSS("object-position", "80% 50%");
  await expect(background).toHaveCSS("pointer-events", "none");
  await background.locator("img").evaluate((image: HTMLImageElement) => image.decode());
  const ambientScreenshot = await page.screenshot();
  await page.getByRole("button", { name: "65%", exact: true }).click();
  await expect(background.locator("img")).toHaveCSS("opacity", "0.65");
  const fullScreenshot = await page.screenshot();
  const blueDifference = await page.evaluate(
    async ([ambient, full]) => {
      const pixel = async (data: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(image.width - 40, 200, 1, 1).data[2];
      };
      return (await pixel(full)) - (await pixel(ambient));
    },
    [ambientScreenshot.toString("base64"), fullScreenshot.toString("base64")],
  );
  expect(blueDifference).toBeGreaterThan(30);
  await page.getByTestId("skin-file-input").setInputFiles({
    name: "ocean.zip",
    mimeType: "application/zip",
    buffer: makePackage("Ocean", "light"),
  });
  await expect(page.getByText("Active: Ocean", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply Mountain", exact: true }).click();
  await expect(page.getByText("Active: Mountain", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalTimeOrigin);
  await expect(background.locator("img")).toHaveCSS("opacity", "0.65");
  await page.screenshot({ path: testInfo.outputPath("image-skin-settings.png"), fullPage: true });
  const workspace = await seedWorkspace({ repoPrefix: "image-skin-", title: "Skin workspace" });
  try {
    await gotoAppShell(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(background.locator("img")).toHaveCSS("opacity", "0.65");
    await background.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    await page.screenshot({
      path: testInfo.outputPath("image-skin-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  await page.reload();
  await expect(page.getByText("Active: Mountain", { exact: true })).toBeVisible();
  await expect(background).toBeVisible();
  await page.getByLabel("Theme: Mountain", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Pure black", exact: true }).click();
  await expect(background).toHaveCount(0);
  await expect(page.getByLabel("Theme: Pure black", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply Mountain", exact: true })).toBeVisible();
  await page.reload();
  await expect(background).toHaveCount(0);
  await expect(page.getByLabel("Theme: Pure black", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply Mountain", exact: true }).click();
  await expect(background.locator("img")).toHaveCSS("opacity", "0.65");
  await expect(page.getByLabel("Theme: Mountain", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("skin-theme-picker.png"), fullPage: true });
  await page.getByRole("button", { name: "Restore default", exact: true }).click();
  await expect(background).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply Mountain", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply Ocean", exact: true }).click();
  await page.getByRole("button", { name: "Remove skin", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply Ocean", exact: true })).toHaveCount(0);
  await expect(background).toHaveCount(0);
});

test("image skin import errors remain visible and allow retry", async ({ page }) => {
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  await page.getByTestId("skin-file-input").setInputFiles({
    name: "invalid.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "Could not apply skin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import theme ZIP", exact: true })).toBeEnabled();
  await expect(page.getByTestId("skin-background")).toHaveCount(0);
});

test("shows Pure black in the appearance picker", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const themeTrigger = page.getByLabel("Theme: System", { exact: true });
  await themeTrigger.click();
  await expect(page.getByText("Pure black", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});

test("keeps the selected workspace visible in Light", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "light-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "light" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(228, 228, 231)");
    await page.screenshot({
      path: testInfo.outputPath("light-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("keeps the selected workspace visible in Pure black", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "pure-black-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "pureBlack" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(17, 17, 17)");
    await page.screenshot({
      path: testInfo.outputPath("pure-black-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiBaseFontSize: 21 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const interfaceSizeInput = page.getByLabel("Interface font size");
  const contentSizeInput = page.getByLabel("Content font size");
  await expect(interfaceSizeInput).toHaveValue("21");
  await expect(contentSizeInput).toHaveValue("21");
  await interfaceSizeInput.fill("12");
  await interfaceSizeInput.press("Tab");

  await expect(interfaceSizeInput).toHaveValue("12");
  await expect(contentSizeInput).toHaveValue("21");
  await expect(sectionTitle).toHaveCSS("font-size", "10px");
});

test("Bing daily wallpaper is separate from image skins and survives reload", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  const artwork = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 80;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#306090";
    context.fillRect(0, 0, 80, 80);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const buffer = Buffer.from(
    zipSync({
      "theme.json": strToU8(
        JSON.stringify({
          schemaVersion: 1,
          id: "bing-switch-test",
          name: "Bing switch test",
          image: "background.png",
          appearance: "dark",
        }),
      ),
      "background.png": Buffer.from(artwork, "base64"),
    }),
  );
  await page
    .getByTestId("skin-file-input")
    .setInputFiles({ name: "skin.zip", mimeType: "application/zip", buffer });
  await expect(page.getByTestId("skin-background")).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Use Bing wallpaper", exact: true });
  await expect(
    page.getByText("Connect to a host that supports Bing wallpaper. Update the host if needed.", {
      exact: true,
    }),
  ).toHaveCount(0, { timeout: 45_000 });
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 45_000 });
  await expect(page.getByTestId("skin-background")).toHaveCount(0);
  const background = page.getByTestId("bing-wallpaper-background");
  await expect(background).toBeVisible();
  await expect
    .poll(
      () => background.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const archiveCard = page.getByTestId("bing-archive-card");
  await expect(archiveCard).toHaveCount(1);
  const preview = archiveCard.getByTestId("bing-archive-preview");
  await expect(preview).toBeVisible();
  expect((await preview.boundingBox())?.height).toBeGreaterThan(100);
  await expect(background.locator("img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await page.context().setOffline(true);
  try {
    await archiveCard.getByRole("button", { name: /^Apply / }).click();
    await expect(
      page.getByText("Fixed wallpaper · new daily images will still be archived", { exact: true }),
    ).toBeVisible();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await archiveCard.getByRole("button", { name: /^Apply / }).click();
    await expect(toggle).toBeChecked();
    await expect(background.locator("img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  } finally {
    await page.context().setOffline(false);
  }
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByText("Fixed wallpaper · new daily images will still be archived", { exact: true }),
  ).toBeVisible();
  await expect(archiveCard).toHaveCount(1);
  await expect(background.locator("img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await page.getByRole("button", { name: "Resume daily updates", exact: true }).click();
  await expect(page.getByText("Daily updates", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("bing-wallpaper-desktop.png") });
  await expect(page.getByLabel("Theme: System", { exact: true })).toBeVisible();
  const workspace = await seedWorkspace({ repoPrefix: "bing-wallpaper-", title: "Bing wallpaper" });
  try {
    await gotoAppShell(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    await background.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    await page.screenshot({ path: testInfo.outputPath("bing-wallpaper-workspace.png") });
  } finally {
    await workspace.cleanup();
  }
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(background).toBeVisible();
  await expect(page.getByTestId("skin-background")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(background).toHaveCount(0);
  await expect(page.getByTestId("skin-background")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 45_000 });
  await page.getByRole("button", { name: "Apply Bing switch test", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(background).toHaveCount(0);
  await expect(page.getByTestId("skin-background")).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 45_000 });
  await page
    .getByTestId("skin-file-input")
    .setInputFiles({ name: "skin.zip", mimeType: "application/zip", buffer });
  await expect(toggle).not.toBeChecked();
  await expect(background).toHaveCount(0);
  await expect(page.getByTestId("skin-background")).toBeVisible();
});
