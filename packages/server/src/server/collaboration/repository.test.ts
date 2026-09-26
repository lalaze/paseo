import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitRepository, executeCheck } from "./repository.js";
import { settings } from "./test-utils/harness.js";
import type { Run } from "@getpaseo/protocol/collaboration/schema";
const exec = promisify(execFile);

test("current-workspace mode preserves dirty work and index, reviews existing changes, and refuses switched checkouts", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-current-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await writeFile(join(repo, "deleted.txt"), "delete me\n");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await writeFile(join(repo, "app.txt"), "staged\n");
  await exec("git", ["add", "app.txt"], { cwd: repo });
  await writeFile(join(repo, "app.txt"), "unsaved\n");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  await writeFile(join(repo, "ignored.txt"), "ignored\n");
  await rm(join(repo, "deleted.txt"));
  const status = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout;
  const staged = (await exec("git", ["diff", "--cached", "--binary"], { cwd: repo })).stdout;
  const work = await repository.prepare(repo, "current", true);
  assert.equal(work.cwd, repo);
  assert.equal(work.branch, "director/current");
  assert.equal(work.baseCommit, baseCommit);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), baseCommit);
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(),
    work.branch,
  );
  assert.equal(
    (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(
      /^worktree /gm,
    )?.length,
    1,
  );
  assert.deepEqual(await repository.prepare(repo, "current", true), work);
  const run = { ...work, id: "current", workspaceId: "workspace", settings: settings() } as Run;
  const evidence = await repository.capture(run);
  assert.deepEqual(evidence.changedFiles, ["app.txt", "deleted.txt", "new.txt"]);
  assert.match(evidence.diff, /unsaved/);
  assert.match(evidence.diff, /untracked/);
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout, status);
  assert.equal((await exec("git", ["diff", "--cached", "--binary"], { cwd: repo })).stdout, staged);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "unsaved\n");
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await readFile(join(repo, "ignored.txt"), "utf8"), "ignored\n");
  await writeFile(join(repo, "app.txt"), "after\n");
  const updated = await repository.capture(run);
  assert.notEqual(updated.id, evidence.id);
  assert.match(updated.diff, /after/);
  assert.equal((await exec("git", ["diff", "--cached", "--binary"], { cwd: repo })).stdout, staged);
  assert.equal((await exec("git", ["show", "main:app.txt"], { cwd: repo })).stdout, "before\n");
  await exec("git", ["switch", "main"], { cwd: repo });
  await assert.rejects(repository.capture(run), /切回 director\/current/);
});

test("isolated mode leaves uncommitted source changes in place", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-isolated-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  await writeFile(join(repo, "new.txt"), "untracked\n");
  const work = await repository.prepare(repo, "isolated");
  assert.notEqual(work.cwd, repo);
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(),
    "main",
  );
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "untracked\n");
  await assert.rejects(readFile(join(work.cwd, "new.txt"), "utf8"));
  assert.equal(
    (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(
      /^worktree /gm,
    )?.length,
    2,
  );
});

test("isolated mode uses the injected Paseo worktree and still resumes a Director worktree", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-official-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  let calls = 0;
  const official = new GitRepository(join(root, "state"), async (request) => {
    calls += 1;
    assert.equal(request.repository, repo);
    assert.equal(request.runId, "run-1");
    assert.equal(request.baseCommit, baseCommit);
    assert.equal(request.branch, "director/run-1");
    assert.equal(request.reuseBranch, false);
    return { cwd: repo, branch: request.branch, workspaceId: "ws-official" };
  });
  const created = await official.prepare(repo, "run-1");
  assert.equal(calls, 1);
  assert.equal(created.cwd, repo);
  assert.equal(created.workspaceId, "ws-official");
  assert.equal(created.branch, "director/run-1");
  assert.equal(
    (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(
      /^worktree /gm,
    )?.length,
    1,
  );

  const legacy = new GitRepository(join(root, "legacy"));
  const existing = await legacy.prepare(repo, "run-2");
  const resumed = new GitRepository(join(root, "legacy"), async () => {
    throw new Error("已有 Director 工作区不应再创建 Paseo worktree");
  });
  assert.deepEqual(await resumed.prepare(repo, "run-2"), existing);
});

test("isolated mode cuts the worktree at the git root and skips recovery until the director branch exists", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-subdir-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const app = join(repo, "packages", "app");
  await mkdir(app, { recursive: true });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  let requested = "";
  const created = await new GitRepository(join(root, "state"), async (request) => {
    requested = request.repository;
    return { cwd: request.repository, branch: request.branch, workspaceId: "ws" };
  }).prepare(app, "run-sub");
  assert.equal(requested, repo);
  assert.equal(created.repository, repo);
  assert.equal(created.cwd, repo);

  let lookedUp = 0;
  await new GitRepository(
    join(root, "fresh"),
    async () => ({ cwd: repo, branch: "director/run-sub", workspaceId: "new" }),
    async () => {
      lookedUp += 1;
      return undefined;
    },
  ).prepare(repo, "run-sub");
  assert.equal(lookedUp, 0);
  await exec("git", ["branch", "director/run-sub"], { cwd: repo });
  let recoveredLookups = 0;
  const recovered = await new GitRepository(
    join(root, "again"),
    async () => {
      throw new Error("已有分支时应先恢复工作区");
    },
    async () => {
      recoveredLookups += 1;
      return { cwd: repo, branch: "director/run-sub", workspaceId: "kept" };
    },
  ).prepare(repo, "run-sub");
  assert.equal(recoveredLookups, 1);
  assert.equal(recovered.workspaceId, "kept");
});

test("an interrupted Paseo worktree is reused by run id and a mismatched create is discarded", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-recover-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  await exec("git", ["branch", "director/run-1"], { cwd: repo });
  const branch = "director/run-1";
  let created = 0;
  const recovered = new GitRepository(
    join(root, "state"),
    async () => {
      created += 1;
      return { cwd: repo, branch, workspaceId: "new" };
    },
    async (request) => {
      assert.equal(request.runId, "run-1");
      assert.equal(request.branch, branch);
      return { cwd: repo, branch, workspaceId: "existing", baseCommit: "abc" };
    },
  );
  const again = await recovered.prepare(repo, "run-1");
  assert.equal(created, 0);
  assert.equal(again.workspaceId, "existing");
  assert.equal(again.baseCommit, "abc");
  assert.equal(again.branch, branch);

  // A leftover branch without a worktree is checked out again and keeps its own base.
  await exec("git", ["branch", "director/run-2"], { cwd: repo });
  const leftoverBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await writeFile(join(repo, "app.txt"), "after\n");
  await exec("git", ["commit", "-am", "later"], { cwd: repo });
  let reused: boolean | undefined;
  const checkedOut = await new GitRepository(
    join(root, "leftover"),
    async (request) => {
      reused = request.reuseBranch;
      return { cwd: repo, branch: request.branch, workspaceId: "checked-out" };
    },
    async () => undefined,
  ).prepare(repo, "run-2");
  assert.equal(reused, true);
  assert.equal(checkedOut.baseCommit, leftoverBase);

  const discarded: string[] = [];
  const mismatched = new GitRepository(
    join(root, "mismatch"),
    async () => ({ cwd: repo, branch: "director/run-3-1", workspaceId: "leak" }),
    async () => undefined,
    async (workspace) => {
      discarded.push(workspace.workspaceId ?? "");
    },
  );
  await assert.rejects(mismatched.prepare(repo, "run-3"), /协作工作区分支不匹配/);
  assert.deepEqual(discarded, ["leak"]);
});

test("current-workspace mode refuses unresolved conflicts without switching branches", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-conflict-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  await exec("git", ["switch", "-c", "other"], { cwd: repo });
  await writeFile(join(repo, "app.txt"), "other\n");
  await exec("git", ["commit", "-am", "other"], { cwd: repo });
  await exec("git", ["switch", "main"], { cwd: repo });
  await writeFile(join(repo, "app.txt"), "main\n");
  await exec("git", ["commit", "-am", "main"], { cwd: repo });
  await assert.rejects(exec("git", ["merge", "other"], { cwd: repo }));
  const status = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout;
  await assert.rejects(
    new GitRepository(join(root, "state")).prepare(repo, "conflict", true),
    /未解决的合并冲突/,
  );
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(),
    "main",
  );
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout, status);
});

test("worktree and immutable snapshot include untracked source, preserve user's index, and catch failing checks", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-git-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  const work = await repository.prepare(repo, "run-1");
  const run = { ...work, id: "run-1", settings: settings() } as Run;
  assert.notEqual(work.cwd, repo);
  await writeFile(join(work.cwd, "app.txt"), "after\n");
  await writeFile(join(work.cwd, "new.txt"), "new file\n");
  const beforeIndex = (await exec("git", ["diff", "--cached"], { cwd: work.cwd })).stdout;
  const evidence = await repository.capture(run);
  assert.deepEqual(evidence.changedFiles.sort(), ["app.txt", "new.txt"]);
  assert.match(await readFile(evidence.diffPath, "utf8"), /new file/);
  assert.equal((await repository.capture(run)).id, evidence.id);
  assert.equal((await exec("git", ["diff", "--cached"], { cwd: work.cwd })).stdout, beforeIndex);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "before\n");
  run.settings.verificationCommands = [
    {
      label: "pass",
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      timeoutMs: 1000,
    },
  ];
  assert.equal((await repository.verify(run, new AbortController().signal)).passed, true);
  run.settings.verificationCommands[0].args = ["-e", "process.exit(1)"];
  assert.equal((await repository.verify(run, new AbortController().signal)).passed, false);
  run.settings.verificationCommands = [];
  const noChecks = await repository.verify(run, new AbortController().signal);
  assert.equal(noChecks.id, evidence.id);
  assert.equal(noChecks.verificationStatus, "not_configured");
  assert.equal(noChecks.passed, false);
  assert.deepEqual(noChecks.checks, []);
  assert.match(noChecks.diff, /new file/);
});

test("saved snapshot patches apply cleanly and preserve exact text and binary contents", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "director-patch-")));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  const work = await repository.prepare(repo, "patch"),
    run = { ...work, id: "patch", settings: settings() } as Run;
  for (const content of [
    "after\n",
    "after  \t\n",
    "after without newline",
    Buffer.from([0, 1, 255, 10, 0, 32]),
  ]) {
    await writeFile(join(work.cwd, "app.txt"), content);
    const evidence = await repository.capture(run);
    const patch = await readFile(evidence.diffPath, "utf8");
    const rawDiff = (
      await exec("git", ["diff", "--binary", work.baseCommit, evidence.tree, "--"], {
        cwd: work.cwd,
      })
    ).stdout;
    assert.equal(patch, rawDiff);
    assert.equal(evidence.diff, rawDiff);
    await exec("git", ["apply", "--check", evidence.diffPath], { cwd: repo });
    await exec("git", ["apply", "--whitespace=nowarn", evidence.diffPath], { cwd: repo });
    assert.deepEqual(await readFile(join(repo, "app.txt")), Buffer.from(content));
    await exec("git", ["apply", "--reverse", "--whitespace=nowarn", evidence.diffPath], {
      cwd: repo,
    });
  }
});

test("verification timeout and cancellation terminate the subprocess", async () => {
  const controller = new AbortController();
  const pending = executeCheck(
    {
      label: "cancel",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 5000,
    },
    tmpdir(),
    controller.signal,
  );
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.exitCode, null);
  assert.match(outcome.output, /取消/);
  const timeout = await executeCheck(
    {
      label: "timeout",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 20,
    },
    tmpdir(),
    new AbortController().signal,
  );
  assert.equal(timeout.exitCode, null);
  assert.match(timeout.output, /超时/);
});
