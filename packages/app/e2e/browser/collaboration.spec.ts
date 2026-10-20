import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { composerLocator, submitMessageWithButton } from "../support/helpers/composer";
import { openCommandCenter } from "../support/helpers/command-center";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Run } from "@getpaseo/protocol/collaboration/schema";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

const gitExec = promisify(execFile);

test.use({ e2eInjectPaseoTools: true });

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`collaboration notices update one progress card across replies and reload on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "collaboration-progress-",
      title: "Unified progress",
    });
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "collaboration-progress",
    });
    async function sendNotice(
      conversation: string,
      sequence: number,
      message: string,
      state: { phase?: string; control?: string } = {},
    ) {
      const id = `chat-notice:${conversation}:digest:${sequence}`;
      const text = `[paseo-director-chat:${id}]\n后台状态通知。\n${JSON.stringify({ message, ...state })}`;
      await client.sendMessage(session.agentId, text, { messageId: id });
      await session.client.waitForAgentUpsert(
        session.agentId,
        (agent) => agent.status === "idle",
        15_000,
      );
    }
    try {
      await sendNotice("first-round", 0, "Implementation started");
      await openAgentRoute(page, session);
      const cards = page.getByTestId("collaboration-progress-card");
      const first = cards.first();
      await expect(cards).toHaveCount(1);
      await expect(first.getByTestId("collaboration-progress-current")).toContainText(
        "Implementation started",
      );
      await expect(first.getByTestId("collaboration-progress-history")).toHaveCount(0);
      await first.getByTestId("collaboration-progress-toggle").click();
      await expect(first.getByTestId("collaboration-stage")).toHaveCount(1);
      // A real daemon message arrives while the card is expanded. The card must update in place.
      await sendNotice("first-round", 1, "Review passed");
      await expect(cards).toHaveCount(1);
      await expect(first.getByTestId("collaboration-progress-current")).toContainText(
        "Review passed",
      );
      await expect(first.getByTestId("collaboration-stage")).toHaveCount(2);
      await expect(page.getByText("[paseo-director-chat:", { exact: false })).toHaveCount(0);
      await first.scrollIntoViewIfNeeded();
      const bounds = await first.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      await first.getByTestId("collaboration-stage").first().click();
      await expect(first.getByText("后台状态通知。", { exact: true })).toBeVisible();
      await first.getByTestId("collaboration-stage").first().click();
      await page.screenshot({ path: testInfo.outputPath(`progress-${viewport.name}.png`) });
      await page.reload({ waitUntil: "commit" });
      await expect(cards).toHaveCount(1);
      await expect(first.getByTestId("collaboration-progress-current")).toContainText(
        "Review passed",
      );
      await first.getByTestId("collaboration-progress-toggle").click();
      await expect(first.getByTestId("collaboration-stage")).toHaveCount(2);
      const evidence = "Detailed evidence: the queued reimbursement reminder still sends twice.";
      await sendNotice("first-round", 2, `Six service tests still fail.\n\n${evidence}`, {
        phase: "executing",
        control: "needs_attention",
      });
      const current = first.getByTestId("collaboration-progress-current");
      await expect(current).toContainText("Collaboration · implementation");
      await expect(current).toContainText("Needs attention");
      await expect(current).not.toContainText(evidence);
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`blocked-preview-${viewport.name}.png`) });
      const stage = first.getByTestId("collaboration-stage").last();
      await stage.click();
      await expect(first.getByText(evidence, { exact: false }).last()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`blocked-${viewport.name}.png`) });
      await sendNotice("second-round", 0, "Another collaboration task");
      await expect(cards).toHaveCount(2);
      await expect(cards.last()).toContainText("Another collaboration task");
    } finally {
      await client.close();
      await session.cleanup();
    }
  });
}

test("plan approval shows the saved plan before approval on desktop and phone", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "collaboration-plan-",
    title: "Plan approval",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "collaboration-plan" });
  let db: DatabaseSync | undefined;
  try {
    const requestId = `plan-${session.agentId}`;
    const opened = await client.collaborationCommand("conversation.open", {
      requestId,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      settings: {
        profiles: [
          { id: "mock", label: "Mock", provider: "mock/e2e-fast-stream", modeId: "load-test" },
        ],
        directorProfileId: "mock",
        workerProfileId: "mock",
        requirePlanApproval: true,
      },
    });
    const conversation = opened.conversations.find((entry) => entry.requestId === requestId)!;
    const task = {
      id: "input-validation",
      title: "Validate incoming messages",
      description: "Reject empty input before sending messages to the worker.",
      category: "backend",
      files: ["src/input-validation.ts"],
      dependsOn: [],
      acceptance: ["Empty input returns a readable validation error."],
    };
    const run: Run = {
      id: requestId,
      requestId,
      revision: 0,
      goal: "Show the collaboration plan before asking for approval",
      repository: session.cwd,
      cwd: session.cwd,
      baseCommit: "unused-before-approval",
      branch: "main",
      workspaceId: session.workspaceId,
      settings: conversation.settings!,
      chat: { version: 1, conversationId: conversation.id, mainAgentId: conversation.agentId! },
      directorAgentId: conversation.agentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: "planning",
      control: "paused",
      message: "Plan ready; awaiting approval",
      planApproved: false,
      planVersion: 1,
      plan: {
        summary: "Validate messages while preserving valid requests.",
        architecture: "Validate at the API boundary and keep the existing message format.",
        acceptance: ["Valid messages still reach the worker."],
        tasks: [task],
      },
      tasks: [{ spec: task, profileId: "mock", status: "pending", reworks: 0 }],
      operations: [],
      events: [],
    };
    db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO runs VALUES (?,?,?,?)").run(
      run.id,
      run.requestId,
      run.revision,
      JSON.stringify(run),
    );
    db.prepare("UPDATE conversations SET data=json_set(data,'$.runId',?) WHERE id=?").run(
      run.id,
      conversation.id,
    );
    db.exec("COMMIT");
    await openAgentRoute(page, session);
    const card = page.getByTestId("collaboration-plan");
    const progress = page.getByTestId("collaboration-progress-card");
    const approve = page.getByRole("button", { name: "Approve plan", exact: true });
    await expect(approve).toBeVisible();
    await expect(progress).toHaveCount(1);
    await expect(progress.getByTestId("collaboration-plan")).toBeVisible();
    await expect(progress.getByTestId("collaboration-progress-history")).toHaveCount(0);
    await expect(card.getByTestId("collaboration-confirmation-actions")).toBeVisible();
    await expect(card).toContainText("Approving starts implementation in the workspace.");
    for (const viewport of [
      { name: "desktop", width: 1280, height: 1000 },
      { name: "phone", width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toContainText(run.plan!.summary);
      await expect(card).toContainText(run.plan!.architecture);
      await expect(card).toContainText(run.plan!.acceptance[0]);
      await expect(card).toContainText(task.title);
      await expect(card).toContainText(task.description);
      await expect(card).toContainText(task.files[0]);
      await expect(card).toContainText(task.acceptance[0]);
      const bounds = await card.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      const cardHeader = card.getByRole("button", { name: "Plan", exact: true });
      await cardHeader.click();
      await expect(card).not.toContainText(task.description);
      await expect(approve).toBeVisible();
      await cardHeader.click();
      await expect(card.getByText(task.description, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`plan-${viewport.name}.png`) });
    }
    // Leaving the pending stage must retain this notice's original plan in the timeline.
    await client.collaborationCommand("run.control", { id: run.id, action: "cancel" });
    await expect(approve).toHaveCount(0);
    await page.reload({ waitUntil: "commit" });
    await expect(card).toContainText(run.plan!.architecture);
    await expect(card).toContainText(task.description);
  } finally {
    db?.close();
    await client.close();
    await session.cleanup();
  }
});

async function seedAcceptance(local = true) {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "collaboration-delivery-",
    title: "Delivery",
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-delivery",
  });
  let db: DatabaseSync | undefined;
  try {
    const requestId = `delivery-${session.agentId}`;
    const opened = await client.collaborationCommand("conversation.open", {
      requestId,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      settings: {
        profiles: [
          { id: "mock", label: "Mock", provider: "mock/e2e-fast-stream", modeId: "load-test" },
        ],
        directorProfileId: "mock",
        workerProfileId: "mock",
      },
    });
    const conversation = opened.conversations.find((entry) => entry.requestId === requestId)!;
    db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
    const moduleUrl = pathToFileURL(
      resolve(__dirname, "../../../server/dist/server/server/collaboration/repository.js"),
    ).href;
    const { GitRepository } = (await import(
      moduleUrl
    )) as typeof import("../../../server/dist/server/server/collaboration/repository.js");
    const repository = new GitRepository(join(process.env.E2E_PASEO_HOME!, "director"));
    const workspace = await repository.prepare(session.cwd, requestId, local);
    await writeFile(join(workspace.cwd, "accepted.md"), "Reviewed collaboration result\n");
    const spec = {
      id: "task-1",
      title: "Implement",
      description: "Add the reviewed file",
      category: "implementation",
      files: ["accepted.md"],
      dependsOn: [],
      acceptance: ["Reviewed file exists"],
    };
    const run: Run = {
      ...workspace,
      id: requestId,
      requestId,
      revision: 0,
      goal: "Deliver reviewed collaboration changes",
      settings: conversation.settings!,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(local ? { workspaceId: session.workspaceId } : {}),
      chat: { version: 1, conversationId: conversation.id, mainAgentId: conversation.agentId! },
      directorAgentId: conversation.agentId,
      phase: "awaiting_acceptance",
      control: "paused",
      message: "Review passed; awaiting acceptance",
      planApproved: true,
      plan: {
        summary: "Implement",
        architecture: "Add a file",
        acceptance: spec.acceptance,
        tasks: [spec],
      },
      tasks: [
        { spec, profileId: conversation.settings!.workerProfileId, status: "executed", reworks: 0 },
      ],
      operations: [],
      events: [],
    };
    run.finalEvidence = { ...(await repository.capture(run)), checks: [], passed: true };
    run.finalReview = {
      decision: "approved",
      artifactId: run.finalEvidence.id,
      summary: "Reviewed",
      criteria: [{ criterion: spec.acceptance[0], passed: true, evidence: "Reviewed file" }],
      findings: [],
    };
    // Seed an AI-reviewed checkpoint; the browser exercises the actual user acceptance,
    // network request, daemon validation and Git delivery without relying on model reasoning.
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO runs VALUES (?,?,?,?)").run(
      run.id,
      run.requestId,
      run.revision,
      JSON.stringify(run),
    );
    db.prepare("UPDATE conversations SET data=json_set(data,'$.runId',?) WHERE id=?").run(
      run.id,
      conversation.id,
    );
    db.exec("COMMIT");
    return {
      session,
      client,
      db,
      run,
      conversation,
      cleanup: async () => {
        db?.close();
        await client.close();
        await session.cleanup();
      },
    };
  } catch (error) {
    db?.close();
    await client.close();
    await session.cleanup();
    throw error;
  }
}

test("acceptance evidence and review history remain readable on desktop and phone after reload", async ({
  page,
}, testInfo) => {
  const fixture = await seedAcceptance();
  try {
    const run = fixture.run;
    run.tasks[0].result = {
      status: "ready_for_review",
      summary: "Added the reviewed file accepted.md.",
      tests: ["Read accepted.md and verified its contents."],
      issues: ["Native device rendering was not verified."],
    };
    run.operations = [
      {
        id: "review-before-repair",
        kind: "final",
        profileId: "mock",
        state: "done",
        prompt: "",
        createdAt: run.createdAt,
        formatRetries: 0,
        response: {
          ...run.finalReview!,
          decision: "changes_requested",
          artifactId: "prior-snapshot",
          findings: [
            {
              id: "F1-1",
              taskId: "task-1",
              location: "accepted.md:1",
              problem: "Missing reviewed text",
              change: "Add the reviewed text",
              verification: "Read the file",
            },
          ],
        },
      },
      {
        id: "review-after-repair",
        kind: "final",
        profileId: "mock",
        state: "done",
        prompt: "",
        createdAt: run.createdAt + 1,
        formatRetries: 0,
        response: run.finalReview,
      },
    ];
    fixture.db.prepare("UPDATE runs SET data=? WHERE id=?").run(JSON.stringify(run), run.id);
    await openAgentRoute(page, fixture.session);
    for (const viewport of [
      { name: "desktop", width: 1280, height: 900 },
      { name: "phone", width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: "commit" });
      const report = page.getByTestId("collaboration-acceptance-report");
      await expect(report).toHaveCount(1);
      const summary = report.getByTestId("collaboration-acceptance-summary");
      await expect(summary).toContainText("Files 1");
      await expect(summary).toContainText("Acceptance criteria 1/1");
      await expect(summary).toContainText("No host checks");
      await expect(summary).toContainText("Reported limitations 1");
      await expect(report.getByTestId("collaboration-acceptance-details")).toHaveCount(0);
      await expect(report.getByTestId("collaboration-accept-and-merge")).toBeVisible();
      await expect(report).toContainText("Merge locally into main");
      await expect(report).not.toContainText(
        "To request changes, describe them in the message box.",
      );
      const progress = page.getByTestId("collaboration-progress-card");
      await progress.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`acceptance-compact-${viewport.name}.png`),
      });
      const compactBounds = await progress.boundingBox();
      expect(compactBounds!.height).toBeLessThan(400);
      await expectInsideViewport(page, "collaboration-acceptance-report", viewport.width);
      expect(await report.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.getByTestId("collaboration-progress-toggle").click();
      await expect(report.getByTestId("collaboration-acceptance-details")).toBeVisible();
      await expect(report).toContainText("Reviewed file exists");
      await expect(report).toContainText(run.finalEvidence!.id.slice(0, 12));
      await expect(report).toContainText("No additional host checks were configured.");
      await expect(report).toContainText("Tests reported by the implementer");
      await expect(report).toContainText("Native device rendering was not verified.");
      const history = page.getByTestId("collaboration-review-history");
      await expect(history).toContainText(
        "Round 1 · Changes requested · 1 blocking issues (1 new, 0 recurring)",
      );
      await expect(history).toContainText(
        "Round 2 · Approved · 0 blocking issues (0 new, 0 recurring)",
      );
      await history.getByTestId("collaboration-review-round-1").click();
      await expect(history).toContainText("F1-1 · accepted.md:1");
      await expect(history).toContainText("Missing reviewed text");
      await expect(history).toContainText("Required change: Add the reviewed text");
      await expect(history).toContainText("Verify with: Read the file");
      await history.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`review-history-${viewport.name}.png`) });
      await page.getByTestId("collaboration-progress-toggle").click();
      await expect(report.getByText("Native device rendering was not verified.")).toHaveCount(0);
      await expect(report.getByTestId("collaboration-accept-and-merge")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`acceptance-collapsed-${viewport.name}.png`),
      });
      const saved = fixture.db
        .prepare("SELECT json_type(data, '$.userAcceptance') AS acceptance FROM runs WHERE id=?")
        .get(run.id);
      expect(saved?.acceptance).toBeNull();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("accept and merge delivers the reviewed files without exiting collaboration", async ({
  page,
}, testInfo) => {
  const fixture = await seedAcceptance();
  try {
    await openAgentRoute(page, fixture.session);
    const merge = page.getByTestId("collaboration-accept-and-merge");
    await expect(merge).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    for (const viewport of [
      { name: "desktop", width: 1280, height: 900 },
      { name: "phone", width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(merge).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`accept-and-merge-${viewport.name}.png`) });
    }
    await merge.click();
    await expect(merge).toHaveCount(0);
    const saved = JSON.parse(
      fixture.db.prepare("SELECT data FROM runs WHERE id=?").get(fixture.run.id)!.data as string,
    ) as Run;
    expect(saved.userAcceptance?.decision).toBe("approved");
    expect(saved.delivery?.status).toBe("merged");
    expect(
      (await gitExec("git", ["show", "main:accepted.md"], { cwd: fixture.session.cwd })).stdout,
    ).toBe("Reviewed collaboration result\n");
    expect(
      (await fixture.client.collaborationCommand("status")).conversations.find(
        (entry) => entry.id === fixture.conversation.id,
      )?.disabledAt,
    ).toBeUndefined();
    for (const viewport of [
      { name: "desktop", width: 1280, height: 900 },
      { name: "phone", width: 390, height: 844 },
    ]) {
      await fixture.session.client.waitForAgentUpsert(
        fixture.session.agentId,
        (agent) => agent.status === "idle",
      );
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: "commit" });
      await expect(page.getByTestId("collaboration-acceptance-summary")).toContainText(
        "Acceptance criteria 1/1",
      );
      const question = `验收合并后继续对话：刚才改了哪些文件？（${viewport.name}）`;
      await submitMessageWithButton(page, question);
      const prompt = page.getByTestId("user-message").filter({ hasText: question });
      const response = prompt.locator('xpath=following::*[@data-testid="assistant-message"]');
      await expect(prompt).toBeVisible();
      await expect(response.first()).toContainText("Cycle 1");
      await expect(response.filter({ hasText: "end of synthetic stream" }).first()).toBeVisible();
      const current = (await fixture.client.collaborationCommand("status")).conversations.find(
        (entry) => entry.id === fixture.conversation.id,
      )!;
      expect(current.agentId).toBe(fixture.session.agentId);
      expect(current.disabledAt).toBeUndefined();
      expect(current.run?.id).toBe(fixture.run.id);
      expect(current.run?.phase).toBe("completed");
      expect(current.run?.deliveryStatus).toBe("merged");
      await prompt.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`chat-after-merge-${viewport.name}.png`) });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("failed accept and merge keeps its error and retries the same accepted result", async ({
  page,
}, testInfo) => {
  const fixture = await seedAcceptance(false);
  try {
    await writeFile(join(fixture.session.cwd, "personal.md"), "Preserve my uncommitted work\n");
    await openAgentRoute(page, fixture.session);
    const merge = page.getByTestId("collaboration-accept-and-merge");
    await expect(merge).toBeVisible();
    await merge.click();
    const error = page.getByTestId("collaboration-confirmation-actions").getByRole("alert");
    await expect(error).toContainText("未提交改动");
    await expect(error).not.toContainText("requestType=");
    await expect(merge).toHaveText("Retry merge");
    await expect(merge).toBeEnabled();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await error.scrollIntoViewIfNeeded();
    await expect(error).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("merge-failed.png") });
    expect(await readFile(join(fixture.session.cwd, "personal.md"), "utf8")).toBe(
      "Preserve my uncommitted work\n",
    );
    await gitExec("git", ["add", "personal.md"], { cwd: fixture.session.cwd });
    await gitExec("git", ["commit", "-m", "Preserve personal work"], { cwd: fixture.session.cwd });
    await merge.click();
    await expect(merge).toHaveCount(0);
    await expect(error).toHaveCount(0);
    expect(await readFile(join(fixture.session.cwd, "accepted.md"), "utf8")).toBe(
      "Reviewed collaboration result\n",
    );
    const saved = JSON.parse(
      fixture.db.prepare("SELECT data FROM runs WHERE id=?").get(fixture.run.id)!.data as string,
    ) as Run;
    expect(saved.delivery?.status).toBe("merged");
  } finally {
    await fixture.cleanup();
  }
});

test("merge recovery can pause, resume, and exit to stop delivery", async ({ page }) => {
  const fixture = await seedAcceptance(false);
  try {
    fixture.run.phase = "completed";
    fixture.run.control = "running";
    fixture.run.userAcceptance = {
      decision: "approved",
      artifactId: fixture.run.finalEvidence!.id,
      decidedAt: Date.now(),
    };
    fixture.run.delivery = {
      status: "failed",
      error: "Merge conflict",
      recovery: { sourceMessageId: "accepted-result" },
    };
    fixture.db
      .prepare("UPDATE runs SET data=? WHERE id=?")
      .run(JSON.stringify(fixture.run), fixture.run.id);
    await page.goto(`/settings/hosts/${getServerId()}/collaboration/history`, {
      waitUntil: "commit",
    });
    const row = page.getByTestId(`collaboration-history-${fixture.conversation.id}`);
    await expect(row.getByText("Needs attention", { exact: true })).toBeVisible();
    await row.getByTestId("collaboration-history-actions").click();
    await expect(
      page.getByRole("menuitem", { name: "Stop collaboration", exact: true }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Pause dispatch", exact: true }).click();
    await expect(row.getByText("Paused", { exact: true })).toBeVisible();
    await row.getByTestId("collaboration-history-actions").click();
    await page.getByRole("menuitem", { name: "Resume", exact: true }).click();
    await expect(row.getByText("Needs attention", { exact: true })).toBeVisible();

    await openAgentRoute(page, fixture.session);
    const control = page.getByTestId("composer-collaboration").filter({ visible: true });
    await expect(control).toContainText("Exit collaboration");
    const dialog = page.waitForEvent("dialog");
    const press = control.click();
    const confirmation = await dialog;
    expect(confirmation.message()).toContain("This stops the collaboration task.");
    await confirmation.accept();
    await press;
    await expect(control).toHaveText("Collaboration");
    const saved = JSON.parse(
      fixture.db.prepare("SELECT data FROM runs WHERE id=?").get(fixture.run.id)!.data as string,
    ) as Run;
    expect(saved.control).toBe("canceled");
    expect(saved.userAcceptance?.decision).toBe("approved");
    expect(await readFile(join(fixture.run.cwd, "accepted.md"), "utf8")).toBe(
      "Reviewed collaboration result\n",
    );
    // The same chat can enable collaboration again after exiting repair.
    const opened = await fixture.client.collaborationCommand("conversation.open", {
      requestId: `after-recovery-${fixture.session.agentId}`,
      workspaceId: fixture.session.workspaceId,
      agentId: fixture.session.agentId,
      settings: fixture.conversation.settings,
    });
    expect(opened.error).toBeNull();
    expect(
      opened.conversations.find((entry) => entry.id === fixture.conversation.id)?.disabledAt,
    ).toBeGreaterThan(0);
  } finally {
    await fixture.cleanup();
  }
});

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
      await expect(page.getByTestId("collaboration-plan-first")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(page.getByTestId("collaboration-director-provider")).toHaveCount(0);
      await chooseModel(page, "worker");
      await page.getByTestId("collaboration-worker-thinking").click();
      await page
        .getByTestId("collaboration-thinking-option-high")
        .filter({ visible: true })
        .click();
      await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
      await chooseModel(page, "reviewer");
      await page.getByTestId("collaboration-reviewer-thinking").click();
      await page
        .getByTestId("collaboration-thinking-option-medium")
        .filter({ visible: true })
        .click();
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
      expect(created[0].settings?.directorProfileId).toBe("reviewer");
      expect(created[0].settings?.reviewerAsLead).toBe(true);
      expect(created[0].settings?.profiles.map((profile) => profile.provider)).toEqual([
        "mock/ten-second-stream",
        "mock/ten-second-stream",
      ]);
      expect(created[0].settings?.profiles.map((profile) => profile.thinkingOptionId)).toEqual([
        "high",
        "medium",
      ]);
      const main = await client.fetchAgent({ agentId: created[0].agentId! });
      expect(main?.agent.model).toBe("ten-second-stream");
      expect(main?.agent.thinkingOptionId).toBe("medium");
      await expect(composerLocator(page)).toBeVisible();
    } finally {
      await client.close();
      await workspace.cleanup();
    }
  });
}

test("one-tap enable reuses the remembered setup without a dialog and starts no task", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-quick-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-quick",
  });
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);

    // Complete the form once so this host remembers the setup.
    await clickNewChat(page);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);

    // The next task reuses it with no dialog and no run: enabling alone starts nothing.
    await clickNewChat(page);
    const control = page.getByTestId("composer-collaboration").filter({ visible: true });
    await expect(control).toBeVisible();
    await control.click();
    await expect
      .poll(async () => (await client.collaborationCommand("status")).conversations.length)
      .toBe(before.conversations.length + 2);
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const after = await client.collaborationCommand("status");
    const created = after.conversations.filter(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    );
    expect(created).toHaveLength(2);
    expect(created.every((entry) => entry.run === undefined)).toBe(true);
  } finally {
    await client.close();
    await workspace.cleanup();
  }
});

test("surfaces a failed one-tap enable, keeps the draft, and resumes the same request on retry", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-retry-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-retry",
  });
  let db: DatabaseSync | undefined;
  let triggerCreated = false;
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);

    // Remember a setup once so the next draft is a one-tap enable.
    await clickNewChat(page);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);

    await clickNewChat(page);
    const draft = "Keep this unsent draft";
    await composerLocator(page).fill(draft);

    // Fail only the next conversation write; removing the workspace would also invalidate
    // the route through the directory watcher before the enable action can run.
    db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(
      "CREATE TRIGGER block_enable BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'test enable write blocked'); END",
    );
    triggerCreated = true;
    const control = page.getByTestId("composer-collaboration").filter({ visible: true });
    await control.click();
    const error = page.getByTestId("composer-collaboration-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("test enable write blocked");
    await expect(composerLocator(page)).toHaveValue(draft);
    await expect(control).toContainText("Retry");
    await expect(page.getByTestId("composer-collaboration-error-dismiss")).toBeVisible();

    // Remove the write failure and retry the same request.
    db.exec("DROP TRIGGER block_enable");
    triggerCreated = false;
    await control.click();
    await expect(error).toHaveCount(0);
    await expect
      .poll(async () => (await client.collaborationCommand("status")).conversations.length)
      .toBe(before.conversations.length + 2);
    const created = (await client.collaborationCommand("status")).conversations.filter(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    );
    expect(created).toHaveLength(2);
    expect(created.filter((entry) => !entry.agentId)).toHaveLength(0);
  } finally {
    if (triggerCreated && db) db.exec("DROP TRIGGER IF EXISTS block_enable");
    db?.close();
    await client.close();
    await workspace.cleanup();
  }
});

test("inherits the conversation's model into the first task and preserves the draft on cancel", async ({
  page,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "collaboration-inherit-",
    title: "Model inheritance",
    model: "ten-second-stream",
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-inherit",
  });
  try {
    const before = await client.collaborationCommand("status");
    await openAgentRoute(page, session);
    const draft = "Keep this unsent draft";
    await composerLocator(page).fill(draft);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    // The first worker inherits the chat's model; review is still unchosen.
    await expect(page.getByTestId("collaboration-worker-model")).toContainText("Ten second stream");
    await expect(page.getByTestId("collaboration-director-provider")).toHaveCount(0);
    await page.getByTestId("collaboration-launch-cancel").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue(draft);
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );
    await page.getByTestId("composer-collaboration-config").filter({ visible: true }).click();
    await chooseModel(page, "reviewer");
    await page.getByTestId("collaboration-reviewer-thinking").click();
    await page
      .getByTestId("collaboration-thinking-option-medium")
      .filter({ visible: true })
      .click();
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const created = (await client.collaborationCommand("status")).conversations.find(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    )!;
    expect(created.agentId).not.toBe(session.agentId);
    expect(created.settings?.directorProfileId).toBe("reviewer");
    const main = await client.fetchAgent({ agentId: created.agentId! });
    expect(main?.agent.thinkingOptionId).toBe("medium");
    await expect(
      page.getByTestId("composer-collaboration").filter({ visible: true }),
    ).toContainText("Exit collaboration");
  } finally {
    await client.close();
    await session.cleanup();
  }
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`advanced settings use only a time budget on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "collaboration-config-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);
      await page.setViewportSize(viewport);
      await page.getByTestId("composer-collaboration-config").filter({ visible: true }).click();
      await expect(page.getByTestId("collaboration-mode-dialog")).toBeVisible();
      await expect(page.getByTestId("collaboration-advanced")).toContainText("4 hours");
      await expect(page.getByTestId("collaboration-manage-prompts")).toHaveCount(0);
      await page.getByTestId("collaboration-advanced-toggle").click();
      await expect(page.getByTestId("collaboration-manage-prompts")).toBeVisible();
      await expect(page.getByTestId("collaboration-max-reworks")).toHaveCount(0);
      await expect(page.getByText("Maximum reworks", { exact: true })).toHaveCount(0);
      await page.getByTestId("collaboration-run-timeout").click();
      await page
        .getByTestId("collaboration-run-timeout-option-8")
        .filter({ visible: true })
        .click();
      await expect(page.getByTestId("collaboration-run-timeout")).toContainText("8 hours");
      await expect(
        page.getByTestId("collaboration-run-timeout-option-8").filter({ visible: true }),
      ).toHaveCount(0);
      await page.getByTestId("collaboration-manage-prompts").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`time-budget-${viewport.name}.png`) });
      await page.getByTestId("collaboration-advanced-toggle").click();
      await expect(page.getByTestId("collaboration-advanced")).toContainText("8 hours");
    } finally {
      await workspace.cleanup();
    }
  });
}

test("an older host cannot silently apply hidden collaboration count limits", async ({ page }) => {
  const gate = await installDaemonWebSocketGate(page);
  gate.setServerFeatureStripped("collaborationTimeBudget", true);
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-time-budget-gate-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-time-budget-gate",
  });
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await page.getByTestId("composer-collaboration-config").filter({ visible: true }).click();
    await chooseModel(page, "worker");
    await chooseModel(page, "reviewer");
    await page.getByTestId("collaboration-continue").click();
    await expect(
      page
        .getByTestId("collaboration-mode-dialog")
        .getByText("Update the host to use collaboration without rework limits.", {
          exact: true,
        }),
    ).toBeVisible();
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );
  } finally {
    gate.restore();
    await client.close();
    await workspace.cleanup();
  }
});

test("requires a host with reviewer-led collaboration before enabling", async ({ page }) => {
  const gate = await installDaemonWebSocketGate(page);
  gate.setServerFeatureStripped("collaborationUnified", true);
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-unified-gate-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-unified-gate",
  });
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await expect(
      page.getByText("Update the host to use reviewer-led collaboration.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );
  } finally {
    gate.restore();
    await client.close();
    await workspace.cleanup();
  }
});

test("preserve inline models and slash-command goal through prompt settings, then launch with planning from the palette", async ({
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
    await page.getByTestId("collaboration-plan-first").click();
    await page.getByTestId("collaboration-plan-approval").click();
    await chooseModel(page, "reviewer");
    // Instructions live under Advanced settings, collapsed by default.
    await page.getByTestId("collaboration-advanced-toggle").click();
    await page.getByTestId("collaboration-manage-prompts").click();
    await page.getByLabel("Review instructions", { exact: true }).fill("Check behavior and tests");
    await page.getByRole("button", { name: "Save collaboration settings", exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId("collaboration-launch-goal")).toContainText(goal);
    await expect(page.getByTestId("collaboration-plan-first")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("collaboration-worker-model")).toContainText("Ten second stream");
    await expect(page.getByTestId("collaboration-plan-approval")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
    await page.getByTestId("collaboration-launch-cancel").click();
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );
    const palette = await openCommandCenter(page);
    await palette.getByTestId("command-center-input").fill("collaboration");
    await palette.getByText("New collaboration conversation", { exact: true }).click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-plan-first").click();
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

test("exits collaboration, keeps the chat normal, and re-enables later", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-exit-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-exit",
  });
  try {
    await gotoWorkspace(page, workspace.workspaceId);

    // Enable once so the host remembers the setup for the one-tap path.
    await clickNewChat(page);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const control = () => page.getByTestId("composer-collaboration").filter({ visible: true });
    await expect(control()).toContainText("Exit collaboration");
    const enabled = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.workspaceId === workspace.workspaceId && !entry.disabledAt,
    )!;
    expect(enabled.agentId).toBeDefined();

    // An unsent draft survives the exit.
    const draft = "Keep this unsent draft";
    await composerLocator(page).fill(draft);

    // No task is running, so the exit closes directly without a confirm dialog.
    await control().click();
    await expect(control()).toHaveText("Collaboration");
    await expect(composerLocator(page)).toHaveValue(draft);
    const afterExit = await client.collaborationCommand("status");
    const closed = afterExit.conversations.filter(
      (entry) => entry.id === enabled.id && entry.disabledAt,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].run).toBeUndefined();
    // The exit closed the same chat it was enabled on, not a replacement.
    expect(closed[0].agentId).toBe(enabled.agentId);

    // The conversation is an ordinary chat again: a normal message is sent, not a task.
    await composerLocator(page).fill("normal chat after exit");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composerLocator(page)).toHaveValue("");
    const stillClosed = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.id === closed[0].id,
    )!;
    expect(stillClosed.run).toBeUndefined();

    // The same chat can be re-enabled under a new conversation.
    await control().click();
    await expect
      .poll(
        async () =>
          (await client.collaborationCommand("status")).conversations.filter(
            (entry) => entry.workspaceId === workspace.workspaceId,
          ).length,
      )
      .toBe(2);
    const active = (await client.collaborationCommand("status")).conversations.filter(
      (entry) => entry.workspaceId === workspace.workspaceId && !entry.disabledAt,
    );
    expect(active).toHaveLength(1);
    await expect(control()).toContainText("Exit collaboration");
  } finally {
    await client.close();
    await workspace.cleanup();
  }
});

test("refreshes task state before exit confirmation and keeps the task when declined", async ({
  page,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-exit-confirm-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-exit-confirm",
  });
  let db: DatabaseSync | undefined;
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    const control = page.getByTestId("composer-collaboration").filter({ visible: true });
    await control.click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect(control).toContainText("Exit collaboration");
    const target = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.workspaceId === workspace.workspaceId && !entry.disabledAt,
    )!;
    expect(target.run).toBeUndefined();

    // Hold the next status poll so the browser still sees an idle chat when a task appears.
    gate.holdNextClientRequest("collaboration.command.request");
    await gate.waitForHeldClientRequest();
    const run: Run = {
      id: "exit-confirm-run",
      requestId: "exit-confirm-run",
      revision: 0,
      goal: "Keep this task until stopping is confirmed",
      repository: workspace.repoPath,
      cwd: workspace.repoPath,
      baseCommit: "unused-by-exit",
      branch: "main",
      workspaceId: workspace.workspaceId,
      settings: target.settings!,
      chat: { version: 1, conversationId: target.id, mainAgentId: target.agentId! },
      directorAgentId: target.agentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: "planning",
      control: "paused",
      message: "Paused before dispatch",
      planApproved: true,
      tasks: [],
      operations: [],
      events: [],
    };
    // Seed a paused checkpoint in the real daemon database without asking the mock model to
    // manufacture a tool call; paused dispatch cannot advance while the confirmation is tested.
    db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO runs VALUES (?,?,?,?)").run(
      run.id,
      run.requestId,
      run.revision,
      JSON.stringify(run),
    );
    db.prepare("UPDATE conversations SET data=json_set(data,'$.runId',?) WHERE id=?").run(
      run.id,
      target.id,
    );
    db.exec("COMMIT");
    expect(
      (await client.collaborationCommand("status")).conversations.find(
        (entry) => entry.id === target.id,
      )?.run?.control,
    ).toBe("paused");

    const draft = "Keep this unsent draft";
    await composerLocator(page).fill(draft);
    const firstDialog = page.waitForEvent("dialog");
    await control.click();
    await expect(control).toContainText("Exiting collaboration");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    gate.releaseHeldClientRequest();
    const declined = await firstDialog;
    expect(declined.message()).toContain("This stops the collaboration task.");
    await declined.dismiss();
    await expect(control).toContainText("Exit collaboration");
    await expect(composerLocator(page)).toHaveValue(draft);
    const kept = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.id === target.id,
    )!;
    expect(kept.disabledAt).toBeUndefined();
    expect(kept.run?.control).toBe("paused");

    const nextDialog = page.waitForEvent("dialog");
    const acceptingPress = control.click();
    const accepted = await nextDialog;
    await accepted.accept();
    await acceptingPress;
    await expect(control).toHaveText("Collaboration");
    await expect(composerLocator(page)).toHaveValue(draft);
    const closed = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.id === target.id,
    )!;
    expect(closed.disabledAt).toBeGreaterThan(0);
    expect(closed.run?.control).toBe("canceled");
  } finally {
    db?.close();
    gate.restore();
    await client.close();
    await workspace.cleanup();
  }
});

test("keeps collaboration enabled and shows the update prompt when the host cannot exit", async ({
  page,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  // An older host does not advertise the capability: the app must say so and never fake the exit.
  gate.setServerFeatureStripped("collaborationDisable", true);
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-exit-gate-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-exit-gate",
  });
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);

    await clickNewChat(page);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const control = page.getByTestId("composer-collaboration").filter({ visible: true });
    await expect(control).toContainText("Exit collaboration");

    await control.click();
    const error = page.getByTestId("composer-collaboration-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Update the host to exit collaboration.");
    // Nothing was closed: the conversation is still active and the control retries the exit.
    await expect(control).toContainText("Retry");
    const after = await client.collaborationCommand("status");
    const created = after.conversations.filter(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    );
    expect(created).toHaveLength(1);
    expect(created[0].disabledAt).toBeUndefined();
  } finally {
    gate.restore();
    await client.close();
    await workspace.cleanup();
  }
});

test("surfaces a failed exit, keeps the draft, and closes the same conversation on retry", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-exit-fail-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-exit-fail",
  });
  const dbPath = join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite");
  let db: DatabaseSync | undefined;
  let triggerCreated = false;
  try {
    await gotoWorkspace(page, workspace.workspaceId);

    // Enable once so the host remembers the setup for the one-tap path.
    await clickNewChat(page);
    const control = () => page.getByTestId("composer-collaboration").filter({ visible: true });
    await control().click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect(control()).toContainText("Exit collaboration");

    await expect
      .poll(
        async () =>
          (await client.collaborationCommand("status")).conversations.filter(
            (entry) => entry.workspaceId === workspace.workspaceId && !entry.disabledAt,
          ).length,
      )
      .toBe(1);
    const target = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.workspaceId === workspace.workspaceId && !entry.disabledAt,
    )!;

    // A real write failure in the daemon's own database, not a mocked transport: this trigger
    // aborts only the target conversation's exit write.
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(
      "CREATE TRIGGER block_exit BEFORE UPDATE OF data ON conversations " +
        `WHEN NEW.id = '${target.id}' AND json_extract(NEW.data,'$.disabledAt') IS NOT NULL ` +
        "BEGIN SELECT RAISE(ABORT,'test exit write blocked'); END",
    );
    triggerCreated = true;

    const draft = "Keep this unsent draft";
    await composerLocator(page).fill(draft);
    await control().click();

    const error = page.getByTestId("composer-collaboration-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("test exit write blocked");
    await expect(control()).toContainText("Retry");
    await expect(composerLocator(page)).toHaveValue(draft);
    await page.screenshot({ path: testInfo.outputPath("exit-failed.png") });
    // Nothing was closed: the target conversation is still active.
    expect(
      (await client.collaborationCommand("status")).conversations.find(
        (entry) => entry.id === target.id,
      )!.disabledAt,
    ).toBeUndefined();

    // Drop the real failure and retry: the same conversation closes and the draft survives.
    db.exec("DROP TRIGGER block_exit");
    triggerCreated = false;
    await control().click();
    await expect(error).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await client.collaborationCommand("status")).conversations.find(
            (entry) => entry.id === target.id,
          )?.disabledAt,
      )
      .toBeGreaterThan(0);
    const closed = (await client.collaborationCommand("status")).conversations.find(
      (entry) => entry.id === target.id,
    )!;
    expect(closed.agentId).toBe(target.agentId);
    await expect(composerLocator(page)).toHaveValue(draft);
    await page.screenshot({ path: testInfo.outputPath("exit-retried.png") });

    // The chat is an ordinary chat again.
    await composerLocator(page).fill("normal chat after exit");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composerLocator(page)).toHaveValue("");
  } finally {
    if (triggerCreated && db) db.exec("DROP TRIGGER IF EXISTS block_exit");
    db?.close();
    await client.close();
    await workspace.cleanup();
  }
});

const handoffViewports = [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "phone", width: 390, height: 844 },
] as const;

async function chooseFallback(page: Page, index: number, modelId: string, thinkingId?: string) {
  await page.getByTestId(`collaboration-fallback-${index}-provider`).click();
  await page.getByTestId("collaboration-provider-option-mock").filter({ visible: true }).click();
  await page.getByTestId(`collaboration-fallback-${index}-model`).click();
  await page.getByTestId(`collaboration-model-option-${modelId}`).filter({ visible: true }).click();
  if (!thinkingId) return;
  await page.getByTestId(`collaboration-fallback-${index}-thinking`).click();
  await page
    .getByTestId(`collaboration-thinking-option-${thinkingId}`)
    .filter({ visible: true })
    .click();
}

async function expectInsideViewport(page: Page, testId: string, width: number) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
}

test("backup models keep their order, per-host memory, and quick reuse", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-backups-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-backups",
  });
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await page.setViewportSize(handoffViewports[0]);
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await chooseModel(page, "reviewer");
    await chooseModel(page, "worker");
    await page.getByTestId("collaboration-fallback-add").click();
    await chooseFallback(page, 0, "ten-second-stream");
    await expect(page.getByTestId("collaboration-fallback-issue-same")).toBeVisible();
    await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
    await page.getByTestId("collaboration-fallback-0-model").click();
    await page
      .getByTestId("collaboration-model-option-thirty-minute-stream")
      .filter({ visible: true })
      .click();
    await expect(page.getByTestId("collaboration-fallback-issue-same")).toHaveCount(0);
    await page.getByTestId("collaboration-fallback-add").click();
    await chooseFallback(page, 1, "five-minute-stream", "high");
    await page.getByTestId("collaboration-fallback-1-up").click();
    await expect(page.getByTestId("collaboration-fallback-0-model")).toContainText(
      "Five minute stream",
    );
    await expect(page.getByTestId("collaboration-fallback-1-model")).toContainText(
      "Thirty minute stream",
    );
    // The launch sheet remounts when the viewport crosses the compact breakpoint, so each
    // width opens its own form. Desktop proves editing; phone proves the saved order.
    await page.getByTestId("collaboration-fallbacks").scrollIntoViewIfNeeded();
    await expectInsideViewport(page, "collaboration-fallbacks", handoffViewports[0].width);
    await page.screenshot({ path: testInfo.outputPath("backups-desktop.png") });
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const created = (await client.collaborationCommand("status")).conversations.find(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    )!;
    expect(created.settings?.executionFallbacks).toEqual({
      worker: [
        { provider: "mock/five-minute-stream", thinkingOptionId: "high" },
        { provider: "mock/thirty-minute-stream" },
      ],
    });
    expect(created.settings?.workerProfileId).toBe("worker");
    expect(created.settings?.profiles.find((profile) => profile.id === "worker")?.provider).toBe(
      "mock/ten-second-stream",
    );

    await clickNewChat(page);
    await page.getByTestId("composer-collaboration-config").filter({ visible: true }).click();
    await expect(page.getByTestId("collaboration-fallback-0-model")).toContainText(
      "Five minute stream",
    );
    await expect(page.getByTestId("collaboration-fallback-1-model")).toContainText(
      "Thirty minute stream",
    );
    await page.getByTestId("collaboration-launch-cancel").click();
    await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    await expect
      .poll(async () => (await client.collaborationCommand("status")).conversations.length)
      .toBe(before.conversations.length + 2);
    const reused = (await client.collaborationCommand("status")).conversations.filter(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    );
    expect(reused).toHaveLength(2);
    expect(reused.every((entry) => entry.run === undefined)).toBe(true);
    expect(reused.map((entry) => entry.settings?.executionFallbacks)).toEqual([
      created.settings?.executionFallbacks,
      created.settings?.executionFallbacks,
    ]);

    // Phone width hides the new-tab control, so reopen the saved form on this chat.
    await page.setViewportSize(handoffViewports[1]);
    await page.getByTestId("composer-collaboration-config").filter({ visible: true }).click();
    await expect(page.getByTestId("collaboration-fallback-0-model")).toContainText(
      "Five minute stream",
    );
    await expect(page.getByTestId("collaboration-fallback-1-model")).toContainText(
      "Thirty minute stream",
    );
    await page.getByTestId("collaboration-fallbacks").scrollIntoViewIfNeeded();
    await expectInsideViewport(page, "collaboration-fallbacks", handoffViewports[1].width);
    await page.screenshot({ path: testInfo.outputPath("backups-phone.png") });
    await page.getByTestId("collaboration-launch-cancel").click();
  } finally {
    await client.close();
    await workspace.cleanup();
  }
});

test("an old host keeps backup rows visible and will not start until they are removed", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const gate = await installDaemonWebSocketGate(page);
  gate.setServerFeatureStripped("collaborationExecutionHandoff", true);
  const workspace = await seedWorkspace({ repoPrefix: "collaboration-handoff-gate-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "collaboration-handoff-gate",
  });
  try {
    const before = await client.collaborationCommand("status");
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    const banner = page.getByTestId("collaboration-handoff-unsupported");
    // Open the form at each width. Resizing an open sheet remounts it and drops the rows.
    for (const viewport of [...handoffViewports].toReversed()) {
      await page.setViewportSize(viewport);
      await page.getByTestId("composer-collaboration").filter({ visible: true }).click();
      await chooseModel(page, "reviewer");
      await chooseModel(page, "worker");
      await page.getByTestId("collaboration-fallback-add").click();
      await chooseFallback(page, 0, "thirty-minute-stream");
      await expect(banner).toHaveText(
        "Update the host to continue on another model when quota runs out.",
      );
      await expect(page.getByTestId("collaboration-continue")).toBeDisabled();
      await expect(page.getByTestId("collaboration-fallback-0")).toBeVisible();
      await banner.scrollIntoViewIfNeeded();
      await expectInsideViewport(page, "collaboration-handoff-unsupported", viewport.width);
      await page.screenshot({ path: testInfo.outputPath(`handoff-gate-${viewport.name}.png`) });
      if (viewport.name === "phone") {
        await page.getByTestId("collaboration-launch-cancel").click();
        await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
        // Leaving the compact sheet can keep a dismiss overlay over the composer.
        await page.setViewportSize(handoffViewports[0]);
        await gotoWorkspace(page, workspace.workspaceId);
      }
    }
    expect((await client.collaborationCommand("status")).conversations).toHaveLength(
      before.conversations.length,
    );
    await page.getByTestId("collaboration-fallback-0-remove").click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("collaboration-continue")).toBeEnabled();
    await page.getByTestId("collaboration-continue").click();
    await expect(page.getByTestId("collaboration-mode-dialog")).toHaveCount(0);
    const created = (await client.collaborationCommand("status")).conversations.find(
      (entry) => !before.conversations.some((old) => old.id === entry.id),
    )!;
    expect(created.settings).not.toHaveProperty("executionFallbacks");
  } finally {
    gate.restore();
    await client.close();
    await workspace.cleanup();
  }
});

async function seedQuotaRun(
  session: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
  options?: { attemptCeiling?: boolean },
) {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "collaboration-quota" });
  const requestId = `quota-${session.agentId}`;
  const opened = await client.collaborationCommand("conversation.open", {
    requestId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    mode: "execute_review",
    settings: {
      profiles: [
        {
          id: "worker",
          label: "Worker",
          provider: "mock/ten-second-stream",
          thinkingOptionId: "high",
        },
        { id: "reviewer", label: "Reviewer", provider: "mock/ten-second-stream" },
      ],
      directorProfileId: "reviewer",
      workerProfileId: "worker",
      reviewerProfileId: "reviewer",
      reviewerAsLead: true,
    },
  });
  const conversation = opened.conversations.find((entry) => entry.requestId === requestId)!;
  const marker = "keep-the-draft\n";
  await writeFile(join(session.cwd, "draft.txt"), marker);
  const operationId = `op-${session.agentId}`;
  const task = {
    id: "draft-file",
    title: "Keep the draft",
    description: "Leave draft.txt in place.",
    category: "frontend",
    files: ["draft.txt"],
    dependsOn: [],
    acceptance: ["draft.txt still contains the original text."],
  };
  const run: Run = {
    id: requestId,
    requestId,
    revision: 0,
    mode: "execute_review",
    goal: "Keep the existing draft while switching models",
    repository: session.cwd,
    cwd: session.cwd,
    baseCommit: "unused",
    branch: "main",
    workspaceId: session.workspaceId,
    settings: {
      ...conversation.settings!,
      ...(options?.attemptCeiling ? { maxAttempts: 3 } : {}),
    },
    chat: { version: 1, conversationId: conversation.id, mainAgentId: conversation.agentId! },
    directorAgentId: conversation.agentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: "executing",
    control: "needs_attention",
    message: "Quota reached",
    planApproved: true,
    tasks: [{ spec: task, profileId: "worker", status: "executing", reworks: 0 }],
    operations: [
      ...(options?.attemptCeiling
        ? [1, 2].map((index) => ({
            id: `prior-${index}-${session.agentId}`,
            kind: "execute" as const,
            taskId: task.id,
            profileId: "worker",
            state: "abandoned" as const,
            superseded: true,
            prompt: "earlier",
            createdAt: Date.now(),
            formatRetries: 0,
            executionModel: { provider: "mock/ten-second-stream" },
          }))
        : []),
      {
        id: operationId,
        kind: "execute" as const,
        taskId: task.id,
        profileId: "worker",
        state: "sent" as const,
        prompt: "continue",
        createdAt: Date.now(),
        formatRetries: 0,
        executionModel: { provider: "mock/ten-second-stream", thinkingOptionId: "high" },
      },
    ],
    activeOperationId: operationId,
    executionRelay: {
      status: "blocked",
      source: "none",
      operationId,
      taskId: task.id,
      profileId: "worker",
      errorClass: "quota",
      message: "usage limit reached",
      attempted: [{ provider: "mock/ten-second-stream" }],
      manual: true,
      token: 3,
      at: Date.now(),
    },
    relayToken: 3,
    events: [],
  };
  const db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO runs VALUES (?,?,?,?)").run(
    run.id,
    run.requestId,
    run.revision,
    JSON.stringify(run),
  );
  db.prepare("UPDATE conversations SET data=json_set(data,'$.runId',?) WHERE id=?").run(
    run.id,
    conversation.id,
  );
  db.exec("COMMIT");
  db.close();
  return { client, conversation, run, operationId, marker };
}

function readRun(id: string): Run {
  const db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  try {
    const row = db.prepare("SELECT data FROM runs WHERE id=?").get(id) as { data: string };
    return JSON.parse(row.data) as Run;
  } finally {
    db.close();
  }
}

function updateRun(id: string, change: (run: Run) => void) {
  const db = new DatabaseSync(join(process.env.E2E_PASEO_HOME!, "director", "director.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT revision, data FROM runs WHERE id=?").get(id) as {
      revision: number;
      data: string;
    };
    const run = JSON.parse(row.data) as Run;
    change(run);
    const revision = row.revision + 1;
    run.revision = revision;
    run.updatedAt = Date.now();
    const result = db
      .prepare("UPDATE runs SET revision=?, data=? WHERE id=? AND revision=?")
      .run(revision, JSON.stringify(run), id, row.revision);
    if (result.changes !== 1) throw new Error("run changed before the test could update it");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function receiptIds(run: Run): string[] {
  return Object.keys(run.relayReceipts ?? {});
}

/** The quota notice is delivered to the collaboration chat, which may be a new lead agent. */
async function openQuotaChat(
  page: Page,
  workspaceId: string,
  conversationId: string,
  client: DaemonClient,
) {
  let agentId = "";
  await expect
    .poll(async () => {
      const status = await client.collaborationCommand("status");
      const conversation = status.conversations.find((entry) => entry.id === conversationId);
      agentId = conversation?.agentId ?? "";
      return conversation?.run?.execution?.relay;
    })
    .toMatchObject({ manual: true, status: "blocked" });
  expect(agentId).not.toBe("");
  // Compact width collapses the tab strip, so open the chat at desktop first.
  await page.setViewportSize(handoffViewports[0]);
  await gotoWorkspace(page, workspaceId);
  const tab = page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
  await expect(tab).toBeVisible();
  await tab.click();
}

async function chooseSwitchModel(page: Page, modelId: string, thinkingId?: string) {
  await page.getByTestId("collaboration-switch-provider").click();
  await page
    .getByTestId("collaboration-switch-provider-option-mock")
    .filter({ visible: true })
    .click();
  await page.getByTestId("collaboration-switch-target").click();
  await page
    .getByTestId(`collaboration-switch-model-option-${modelId}`)
    .filter({ visible: true })
    .click();
  if (!thinkingId) return;
  await page.getByTestId("collaboration-switch-thinking").click();
  await page
    .getByTestId(`collaboration-switch-thinking-option-${thinkingId}`)
    .filter({ visible: true })
    .click();
}

test("quota handoff keeps the task and continues on the chosen model", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "collaboration-switch-",
    title: "Quota switch",
  });
  const fixture = await seedQuotaRun(session);
  try {
    await page.setViewportSize(handoffViewports[0]);
    await openQuotaChat(page, session.workspaceId, fixture.conversation.id, fixture.client);
    const button = page.getByTestId("collaboration-switch-model");
    await expect(button).toHaveCount(1, { timeout: 45_000 });
    await expect(page.getByTestId("collaboration-handoff-status")).toContainText(
      "mock/ten-second-stream",
    );
    for (const viewport of handoffViewports) {
      await page.setViewportSize(viewport);
      await expect(button).toBeVisible();
      await button.scrollIntoViewIfNeeded();
      await expectInsideViewport(page, "collaboration-switch-model", viewport.width);
      await page.screenshot({ path: testInfo.outputPath(`switch-chat-${viewport.name}.png`) });
    }
    const historyUrl = `/settings/hosts/${getServerId()}/collaboration/history`;
    for (const viewport of handoffViewports) {
      // Resize before navigation. The history list remounts across the compact breakpoint.
      await page.setViewportSize(viewport);
      await page.goto(historyUrl, { waitUntil: "commit" });
      const row = page.getByTestId(`collaboration-history-${fixture.conversation.id}`);
      await expect(row).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      await row.getByTestId("collaboration-history-actions").click();
      await expect(page.getByTestId("collaboration-history-switch")).toBeVisible();
      await expectInsideViewport(page, "collaboration-history-switch", viewport.width);
      await page.screenshot({ path: testInfo.outputPath(`switch-history-${viewport.name}.png`) });
      await page.keyboard.press("Escape");
    }
    await openQuotaChat(page, session.workspaceId, fixture.conversation.id, fixture.client);
    await page.setViewportSize(handoffViewports[1]);
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId("collaboration-switch-sheet")).toBeVisible();
    await expect(page.getByTestId("collaboration-switch-current")).toContainText(
      "mock/ten-second-stream",
    );
    await expect(page.getByTestId("collaboration-switch-status")).toContainText(
      "This task, its files, and completed work stay as they are.",
    );
    await chooseSwitchModel(page, "five-minute-stream", "high");
    await expectInsideViewport(page, "collaboration-switch-sheet", handoffViewports[1].width);
    await page.screenshot({ path: testInfo.outputPath("switch-sheet-phone.png") });
    await page.getByTestId("collaboration-switch-cancel").click();
    await expect(page.getByTestId("collaboration-switch-sheet")).toHaveCount(0);
    // Closing the phone sheet can leave a dismiss overlay. Reopen the chat at desktop.
    await openQuotaChat(page, session.workspaceId, fixture.conversation.id, fixture.client);
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    await expect(page.getByTestId("collaboration-switch-sheet")).toBeVisible();
    await chooseSwitchModel(page, "five-minute-stream", "high");
    await expectInsideViewport(page, "collaboration-switch-sheet", handoffViewports[0].width);
    await page.screenshot({ path: testInfo.outputPath("switch-sheet-desktop.png") });
    const submit = page.getByTestId("collaboration-switch-submit");
    await submit.dispatchEvent("click");
    await submit.dispatchEvent("click");
    await expect(page.getByTestId("collaboration-switch-status")).toContainText(
      "Continuing on mock/five-minute-stream",
      { timeout: 30_000 },
    );
    await expect(button).toHaveCount(0);
    const saved = readRun(fixture.run.id);
    expect(saved.id).toBe(fixture.run.id);
    expect(saved.cwd).toBe(fixture.run.cwd);
    expect(saved.branch).toBe(fixture.run.branch);
    expect(saved.tasks.map((task) => task.spec.id)).toEqual(["draft-file"]);
    expect(saved.tasks[0]?.profileId).toBe("worker");
    const execute = saved.operations.filter((operation) => operation.kind === "execute");
    expect(execute).toHaveLength(2);
    expect(execute.find((operation) => operation.id === fixture.operationId)?.superseded).toBe(
      true,
    );
    expect(saved.executionModels?.worker).toEqual({
      provider: "mock/five-minute-stream",
      thinkingOptionId: "high",
    });
    expect(await readFile(join(session.cwd, "draft.txt"), "utf8")).toBe(fixture.marker);
    await page.setViewportSize(handoffViewports[0]);
    await page.goto(historyUrl, { waitUntil: "commit" });
    const doneRow = page.getByTestId(`collaboration-history-${fixture.conversation.id}`);
    await expect(doneRow).toBeVisible();
    await doneRow.getByTestId("collaboration-history-actions").click();
    await expect(page.getByTestId("collaboration-history-switch")).toHaveCount(0);
  } finally {
    await fixture.client.close();
    await session.cleanup();
  }
});

test("a failed model switch keeps the draft and does not start another execution", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  // Cancel consumes the blocked run, so each width gets its own task and shows the error itself.
  for (const viewport of handoffViewports) {
    const session = await seedMockAgentWorkspace({
      repoPrefix: `collaboration-switch-fail-${viewport.name}-`,
      title: "Quota switch failure",
    });
    const fixture = await seedQuotaRun(session);
    try {
      await openQuotaChat(page, session.workspaceId, fixture.conversation.id, fixture.client);
      await page.setViewportSize(viewport);
      const button = page.getByTestId("collaboration-switch-model");
      await expect(button).toBeVisible({ timeout: 45_000 });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await chooseSwitchModel(page, "thirty-minute-stream");
      await fixture.client.collaborationCommand("run.control", {
        id: fixture.run.id,
        action: "cancel",
      });
      await page.getByTestId("collaboration-switch-submit").click();
      const alert = page.getByTestId("collaboration-switch-status");
      await expect(alert).toContainText("任务已结束");
      await expectInsideViewport(page, "collaboration-switch-sheet", viewport.width);
      await page.screenshot({ path: testInfo.outputPath(`switch-error-${viewport.name}.png`) });
      await page.getByTestId("collaboration-switch-cancel").click();
      await expect(button).toHaveCount(0);
      const saved = readRun(fixture.run.id);
      expect(saved.control).toBe("canceled");
      expect(saved.operations.filter((operation) => operation.kind === "execute")).toHaveLength(1);
      expect(saved.cwd).toBe(fixture.run.cwd);
      expect(await readFile(join(session.cwd, "draft.txt"), "utf8")).toBe(fixture.marker);
      await page.goto(`/settings/hosts/${getServerId()}/collaboration/history`, {
        waitUntil: "commit",
      });
      const row = page.getByTestId(`collaboration-history-${fixture.conversation.id}`);
      await row.getByTestId("collaboration-history-actions").click();
      await expect(page.getByTestId("collaboration-history-switch")).toHaveCount(0);
      await page.keyboard.press("Escape");
    } finally {
      await fixture.client.close();
      await session.cleanup();
    }
  }
});

test("a recoverable switch failure keeps the same request and continues on another model", async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  for (const viewport of handoffViewports) {
    const session = await seedMockAgentWorkspace({
      repoPrefix: `collaboration-switch-retarget-${viewport.name}-`,
      title: "Quota switch retarget",
    });
    // Three stored attempts hit the ceiling after the receipt is saved, which leaves the same
    // failed manual relay a stop failure leaves. Raising the ceiling lets the next model continue.
    const fixture = await seedQuotaRun(session, { attemptCeiling: true });
    try {
      await openQuotaChat(page, session.workspaceId, fixture.conversation.id, fixture.client);
      await page.setViewportSize(viewport);
      const button = page.getByTestId("collaboration-switch-model");
      await expect(button).toBeVisible({ timeout: 45_000 });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await chooseSwitchModel(page, "five-minute-stream", "high");
      const submit = page.getByTestId("collaboration-switch-submit");
      const alert = page.getByTestId("collaboration-switch-status");
      await submit.click();
      await expect(alert).toContainText("调用次数上限", { timeout: 30_000 });
      await expect(submit).toBeEnabled();
      await expectInsideViewport(page, "collaboration-switch-sheet", viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`switch-retarget-error-${viewport.name}.png`),
      });
      const failed = readRun(fixture.run.id);
      const firstId = receiptIds(failed)[0];
      if (!firstId) throw new Error("missing switch request");
      expect(failed.executionRelay?.status).toBe("failed");
      expect(failed.operations.filter((operation) => operation.kind === "execute")).toHaveLength(3);
      expect(JSON.parse(failed.relayReceipts?.[firstId]?.fingerprint ?? "{}")).toMatchObject({
        provider: "mock/five-minute-stream",
        thinkingOptionId: "high",
      });
      await submit.click();
      await expect(alert).toContainText("调用次数上限");
      const retried = readRun(fixture.run.id);
      expect(receiptIds(retried)).toEqual([firstId]);
      expect(retried.operations.filter((operation) => operation.kind === "execute")).toHaveLength(
        3,
      );
      await expect(
        fixture.client.collaborationCommand("run.switch_executor", {
          id: fixture.run.id,
          expectedOperationId: fixture.operationId,
          token: 2,
          requestId: firstId,
          model: { provider: "mock/five-minute-stream", thinkingOptionId: "high" },
        }),
      ).rejects.toThrow(/过期/);
      expect(receiptIds(readRun(fixture.run.id))).toEqual([firstId]);
      expect(await readFile(join(session.cwd, "draft.txt"), "utf8")).toBe(fixture.marker);
      await page.getByTestId("collaboration-switch-target").scrollIntoViewIfNeeded();
      await page.getByTestId("collaboration-switch-target").click();
      await page
        .getByTestId("collaboration-switch-model-option-thirty-minute-stream")
        .filter({ visible: true })
        .click();
      updateRun(fixture.run.id, (run) => {
        run.settings.maxAttempts = 40;
      });
      await submit.dispatchEvent("click");
      await submit.dispatchEvent("click");
      await expect(alert).toContainText("Continuing on mock/thirty-minute-stream", {
        timeout: 30_000,
      });
      await expectInsideViewport(page, "collaboration-switch-sheet", viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`switch-retarget-success-${viewport.name}.png`),
      });
      const saved = readRun(fixture.run.id);
      const ids = receiptIds(saved);
      const secondId = ids.find((id) => id !== firstId);
      if (!secondId) throw new Error("missing retarget request");
      expect(ids).toHaveLength(2);
      expect(ids).toContain(firstId);
      expect(JSON.parse(saved.relayReceipts?.[secondId]?.fingerprint ?? "{}")).toMatchObject({
        provider: "mock/thirty-minute-stream",
        thinkingOptionId: null,
      });
      const execute = saved.operations.filter((operation) => operation.kind === "execute");
      expect(execute).toHaveLength(4);
      expect(execute.filter((operation) => !operation.superseded)).toHaveLength(1);
      expect(execute.find((operation) => operation.id === fixture.operationId)?.superseded).toBe(
        true,
      );
      expect(saved.executionModels?.worker).toEqual({ provider: "mock/thirty-minute-stream" });
      expect(saved.id).toBe(fixture.run.id);
      expect(saved.cwd).toBe(fixture.run.cwd);
      expect(saved.branch).toBe(fixture.run.branch);
      expect(saved.tasks.map((task) => task.spec.id)).toEqual(["draft-file"]);
      expect(saved.tasks[0]?.profileId).toBe("worker");
      expect(await readFile(join(session.cwd, "draft.txt"), "utf8")).toBe(fixture.marker);
      await page.getByTestId("collaboration-switch-cancel").click();
      await expect(button).toHaveCount(0);
      await page.goto(`/settings/hosts/${getServerId()}/collaboration/history`, {
        waitUntil: "commit",
      });
      const row = page.getByTestId(`collaboration-history-${fixture.conversation.id}`);
      await row.getByTestId("collaboration-history-actions").click();
      await expect(page.getByTestId("collaboration-history-switch")).toHaveCount(0);
      await page.keyboard.press("Escape");
    } finally {
      await fixture.client.close();
      await session.cleanup();
    }
  }
});
