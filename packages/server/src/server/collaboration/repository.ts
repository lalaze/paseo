import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Run, Evidence, Command } from "@getpaseo/protocol/collaboration/schema";
import { HANDOFF_DIFF_LIMIT, redactHandoffText } from "./handoff.js";
import {
  commitChanges,
  getCheckoutSnapshotFacts,
  mergeToBase,
  parseWorktreeList,
} from "../../utils/checkout-git.js";

export type MergedResult = Extract<NonNullable<Run["delivery"]>, { status: "merged" }>;

export interface MergeRecoveryContext extends Pick<Run, "repository" | "cwd" | "branch"> {
  targetBranch: string;
  targetCwd: string;
  currentBranch: string;
  artifactId: string;
  error: string;
  changedFiles: string[];
  verificationCommands: Run["settings"]["verificationCommands"];
  sourceStatus: string;
  targetStatus: string;
  unmergedFiles: string[];
}

const exec = promisify(execFile);
export interface IsolatedWorkspaceRequest {
  /** Git root of the checkout the task started from. */
  repository: string;
  runId: string;
  baseCommit: string;
  branch: string;
  /** A leftover director branch exists: check it out instead of cutting a new one. */
  reuseBranch: boolean;
}
export interface IsolatedWorkspace {
  cwd: string;
  branch: string;
  workspaceId?: string;
  /** Commit the worktree was cut from, when it is already known. */
  baseCommit?: string;
}
/** Official Paseo worktree creation, the same path `create_workspace` uses. */
export type CreateIsolatedWorkspace = (
  request: IsolatedWorkspaceRequest,
) => Promise<IsolatedWorkspace>;
export type FindIsolatedWorkspace = (
  request: IsolatedWorkspaceRequest,
) => Promise<IsolatedWorkspace | undefined>;
export type DiscardIsolatedWorkspace = (workspace: IsolatedWorkspace) => Promise<void>;
export interface Repository {
  prepare(
    repository: string,
    runId: string,
    currentWorkspace?: boolean,
  ): Promise<{
    repository: string;
    cwd: string;
    baseCommit: string;
    branch: string;
    sourceBranch?: string;
    workspaceId?: string;
  }>;
  assertBranch(run: Run): Promise<void>;
  /** The artifact id of the working tree right now, without writing any artifact. */
  fingerprint(run: Run): Promise<string>;
  /**
   * Read-only paths and a diff against the run baseline. Does not write refs or artifacts.
   * `missing` means a read failed. `truncated` means paths or diff were clipped after counting.
   */
  workingChanges(run: Run): Promise<{
    paths: string[];
    diff: string;
    missing?: boolean;
    truncated?: boolean;
    pathCount?: number;
  }>;
  capture(run: Run): Promise<Omit<Evidence, "checks" | "passed">>;
  verify(run: Run, signal: AbortSignal): Promise<Evidence>;
  mergeAccepted(run: Run): Promise<MergedResult>;
  mergeRecoveryContext(run: Run): Promise<MergeRecoveryContext>;
  /** Best-effort removal of files only this evidence references. */
  discard(evidence: Evidence): Promise<void>;
}
export class GitRepository implements Repository {
  constructor(
    private root: string,
    private createIsolatedWorkspace?: CreateIsolatedWorkspace,
    private findIsolatedWorkspace?: FindIsolatedWorkspace,
    private discardIsolatedWorkspace?: DiscardIsolatedWorkspace,
  ) {}
  private async gitOutput(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
    return (
      await exec("git", args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      })
    ).stdout;
  }
  private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
    return (await this.gitOutput(cwd, args, env)).trimEnd();
  }
  /** Stream git output to a file. Snapshot patches can exceed any in-memory buffer. */
  private async gitToFile(cwd: string, args: string[], path: string) {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      if (stderr.length < 4096) stderr += data.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    await pipeline(child.stdout, createWriteStream(path, { mode: 0o600 }));
    const exitCode = await exited;
    if (exitCode !== 0) throw new Error(`git ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
  }
  private async recordSourceBranch(repository: string, branch: string) {
    const key = `branch.${branch}.paseoSourceBranch`;
    // Keep this across partial preparation/recovery, even if the source checkout switched later.
    const recorded = await this.git(repository, ["config", "--get", key]).catch(() => "");
    if (recorded) return recorded;
    const current = await this.git(repository, ["branch", "--show-current"]);
    if (!current || current === branch) return undefined;
    await this.git(repository, ["config", key, current]);
    return current;
  }
  async prepare(repository: string, runId: string, currentWorkspace = false) {
    if (!isAbsolute(repository)) throw new Error("仓库路径必须是绝对路径");
    const source = await realpath(repository);
    const repositoryRoot = await realpath(await this.git(source, ["rev-parse", "--show-toplevel"]));
    if (currentWorkspace && source !== repositoryRoot)
      throw new Error("请在项目根目录的工作区启动，或选择独立工作区执行");
    if ((await this.git(repositoryRoot, ["ls-files", "--unmerged"])).trim())
      throw new Error("仓库存在未解决的合并冲突，请先解决冲突后再启动 AI 协作");
    const baseCommit = await this.git(repositoryRoot, ["rev-parse", "HEAD"]);
    const legacyCwd = join(this.root, "worktrees", runId);
    const branch = `director/${runId}`;
    const sourceBranch = await this.recordSourceBranch(repositoryRoot, branch);
    if (currentWorkspace) {
      // Branching at HEAD keeps staged, unstaged and untracked work in place.
      // Keep HEAD as the review base so pre-existing changes are reviewed too.
      const currentBranch = await this.git(repositoryRoot, ["branch", "--show-current"]);
      if (currentBranch !== branch) await this.git(repositoryRoot, ["switch", "-c", branch]);
      return {
        repository: repositoryRoot,
        cwd: repositoryRoot,
        baseCommit,
        branch,
        sourceBranch,
      };
    }
    const recovered = await this.recoverLegacyWorktree(legacyCwd, branch);
    if (recovered) {
      return {
        repository: repositoryRoot,
        cwd: legacyCwd,
        baseCommit: recovered,
        branch,
        sourceBranch,
      };
    }
    // A new run has no director branch. Skip the worktree and workspace scans until one exists.
    // A leftover branch was cut before its run was recorded, so its tip is that run's base.
    const leftoverBase = await this.branchTip(repositoryRoot, branch);
    // Cut the worktree at the git root even from a subdirectory: evidence stages `.` from
    // run.cwd, so a subdirectory cwd would drop edits made elsewhere in the repository.
    const request = {
      repository: repositoryRoot,
      runId,
      baseCommit,
      branch,
      reuseBranch: leftoverBase !== undefined,
    };
    const existing = leftoverBase ? await this.findIsolatedWorkspace?.(request) : undefined;
    const base = leftoverBase ?? baseCommit;
    if (existing)
      return {
        ...(await this.adoptIsolatedWorkspace(repositoryRoot, base, existing)),
        sourceBranch,
      };
    if (this.createIsolatedWorkspace) {
      const created = await this.createIsolatedWorkspace(request);
      if (created.branch !== branch) {
        await this.discardIsolatedWorkspace?.(created);
        throw new Error("协作工作区分支不匹配");
      }
      return {
        ...(await this.adoptIsolatedWorkspace(repositoryRoot, base, created)),
        sourceBranch,
      };
    }
    await mkdir(join(this.root, "worktrees"), { recursive: true, mode: 0o700 });
    await this.git(repositoryRoot, ["worktree", "add", "-b", branch, legacyCwd, baseCommit]);
    return {
      repository: repositoryRoot,
      cwd: legacyCwd,
      baseCommit,
      branch,
      sourceBranch,
    };
  }
  private async adoptIsolatedWorkspace(
    repository: string,
    baseCommit: string,
    workspace: IsolatedWorkspace,
  ) {
    return {
      repository,
      cwd: await realpath(workspace.cwd),
      baseCommit: workspace.baseCommit ?? baseCommit,
      branch: workspace.branch,
      ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
    };
  }
  private async branchTip(cwd: string, branch: string): Promise<string | undefined> {
    try {
      return await this.git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    } catch {
      return undefined;
    }
  }
  private async recoverLegacyWorktree(cwd: string, branch: string): Promise<string | undefined> {
    try {
      const existingBase = await this.git(cwd, ["rev-parse", "HEAD"]);
      const existingBranch = await this.git(cwd, ["branch", "--show-current"]);
      if (existingBranch !== branch) throw new Error("恢复工作区的分支不匹配");
      return existingBase;
    } catch (e) {
      if (!(e as NodeJS.ErrnoException).code || (e as Error).message.includes("分支不匹配"))
        throw e;
      return undefined;
    }
  }
  async assertBranch(run: Run) {
    if (run.workspaceId && (await this.git(run.cwd, ["branch", "--show-current"])) !== run.branch)
      throw new Error(`工作区已切换分支，请切回 ${run.branch} 后重试`);
  }
  /** Write the working tree (tracked, untracked, staged) into a throwaway index and return its tree. */
  private async writeTree(run: Run, directory: string) {
    await this.assertBranch(run);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(directory, "index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await this.git(run.cwd, ["read-tree", "HEAD"], env);
      await this.git(run.cwd, ["add", "-A", "--", "."], env);
      const tree = await this.git(run.cwd, ["write-tree"], env);
      return {
        tree,
        id: createHash("sha256")
          .update(run.baseCommit + ":" + tree)
          .digest("hex"),
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async fingerprint(run: Run) {
    return (await this.writeTree(run, join(this.root, "artifacts", run.id))).id;
  }
  async mergeRecoveryContext(run: Run): Promise<MergeRecoveryContext> {
    if (run.delivery?.status !== "failed" || !run.sourceBranch || !run.finalEvidence)
      throw new Error("当前没有可处理的合并失败");
    const worktrees = parseWorktreeList(
      await this.gitOutput(run.cwd, ["worktree", "list", "--porcelain"]),
    );
    const target = worktrees.find((entry) => entry.branchRef === `refs/heads/${run.sourceBranch}`);
    const targetCwd = target?.path ?? run.cwd;
    const currentBranch = await this.git(run.cwd, ["branch", "--show-current"]);
    const sourceStatus = await this.gitOutput(run.cwd, ["status", "--porcelain"]);
    const targetStatus = await this.gitOutput(targetCwd, ["status", "--porcelain"]);
    const unmerged = await this.gitOutput(run.cwd, [
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    return {
      repository: run.repository,
      cwd: run.cwd,
      branch: run.branch,
      targetBranch: run.sourceBranch,
      targetCwd,
      currentBranch,
      artifactId: run.finalEvidence.id,
      error: run.delivery.error,
      changedFiles: run.finalEvidence.changedFiles,
      verificationCommands: run.settings.verificationCommands,
      sourceStatus,
      targetStatus,
      unmergedFiles: unmerged.split("\0").filter(Boolean),
    };
  }
  async mergeAccepted(run: Run): Promise<MergedResult> {
    if (!run.sourceBranch) throw new Error("此任务未记录原分支，请指定合并目标后再交付");
    if (
      !run.finalEvidence ||
      run.userAcceptance?.decision !== "approved" ||
      run.userAcceptance.artifactId !== run.finalEvidence.id
    )
      throw new Error("请先验收当前成果，再合并");
    if ((await this.git(run.cwd, ["branch", "--show-current"])) !== run.branch)
      throw new Error(`请切回成果分支 ${run.branch} 后重试合并`);
    if ((await this.fingerprint(run)) !== run.finalEvidence.id)
      throw new Error("代码已在验收后发生变化，请重新审核并验收后再合并");
    await this.git(run.cwd, ["rev-parse", "--verify", `refs/heads/${run.sourceBranch}`]);
    const worktrees = parseWorktreeList(
      await this.gitOutput(run.cwd, ["worktree", "list", "--porcelain"]),
    );
    const target = worktrees.find((entry) => entry.branchRef === `refs/heads/${run.sourceBranch}`);
    if (
      target &&
      target.path !== run.cwd &&
      (await this.git(target.path, ["status", "--porcelain"]))
    )
      throw new Error(
        `目标分支 ${run.sourceBranch} 有未提交改动，请先处理这些改动再重试合并；成果已保留`,
      );
    const mergeHead = await this.git(run.cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "MERGE_HEAD",
    ]).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === 1) return undefined;
      throw error;
    });
    // A resolution can retain HEAD's tree while still needing a merge commit to record ancestry.
    if (mergeHead || (await this.git(run.cwd, ["status", "--porcelain"]))) {
      await commitChanges(run.cwd, { message: `Paseo: ${run.goal.split("\n")[0].slice(0, 100)}` });
    }
    // Hooks can format source files. Never merge a commit that differs from what the user accepted.
    if (
      (await this.git(run.cwd, ["rev-parse", "HEAD^{tree}"])) !== run.finalEvidence.tree ||
      (await this.fingerprint(run)) !== run.finalEvidence.id
    )
      throw new Error("提交钩子改变了验收成果，请重新审核并验收后再合并；成果提交已保留");
    const commit = await this.git(run.cwd, ["rev-parse", "HEAD"]);
    const facts = await getCheckoutSnapshotFacts(run.cwd);
    if (!facts.isGit) throw new Error("成果工作区已不是 Git 仓库");
    // Collaboration targets the exact local launch branch, independently of the workspace's
    // ordinary upstream/base metadata. The existing merge engine owns worktrees and conflicts.
    const cwd = await mergeToBase(
      run.cwd,
      { baseRef: `refs/heads/${run.sourceBranch}` },
      {
        facts: {
          ...facts,
          storedBaseRef: `refs/heads/${run.sourceBranch}`,
          resolvedBaseRef: `refs/heads/${run.sourceBranch}`,
        },
      },
    );
    return { status: "merged", targetBranch: run.sourceBranch, cwd, commit };
  }
  async workingChanges(run: Run): Promise<{
    paths: string[];
    diff: string;
    missing?: boolean;
    truncated?: boolean;
    pathCount?: number;
  }> {
    const listed = async (args: string[]) => {
      try {
        return { ok: true as const, text: await this.gitOutput(run.cwd, args) };
      } catch {
        return { ok: false as const, text: "" };
      }
    };
    const tracked = await listed(["diff", "--name-only", "-z", run.baseCommit]);
    const untracked = await listed(["ls-files", "--others", "--exclude-standard", "-z"]);
    const diffResult = await listed(["diff", "--unified=1", "--stat", run.baseCommit]);
    if (!tracked.ok || !untracked.ok || !diffResult.ok) {
      return { paths: [], diff: "", missing: true, truncated: false, pathCount: 0 };
    }
    const allPaths = [
      ...new Set(
        [...tracked.text.split("\0"), ...untracked.text.split("\0")]
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ];
    // Redact before clipping so a cut cannot leave a credential value without its field.
    const redacted = redactHandoffText(diffResult.text);
    const paths = allPaths.slice(0, 80);
    const diff = redacted.slice(0, HANDOFF_DIFF_LIMIT);
    return {
      paths,
      diff,
      missing: false,
      truncated: allPaths.length > paths.length || redacted.length > diff.length,
      pathCount: allPaths.length,
    };
  }
  async capture(run: Run) {
    const directory = join(this.root, "artifacts", run.id);
    const { tree, id } = await this.writeTree(run, directory);
    // Patches and NUL-delimited paths must retain their exact whitespace.
    const diffPath = join(directory, `${id}.patch`);
    await this.gitToFile(run.cwd, ["diff", "--binary", run.baseCommit, tree, "--"], diffPath);
    const names = await this.gitOutput(run.cwd, [
      "diff",
      "--name-only",
      "-z",
      run.baseCommit,
      tree,
      "--",
    ]);
    // Keep the tree reachable even if Git prunes loose objects later.
    await this.git(run.cwd, ["update-ref", `refs/paseo-director/${run.id}/${id}`, tree]);
    const previous = run.operations?.findLast(
      (op) => op.state === "done" && op.reviewArtifact,
    )?.reviewArtifact;
    let delta: Evidence["delta"];
    if (previous) {
      const deltaPath = join(directory, `${previous.id}-${id}.patch`);
      await this.gitToFile(run.cwd, ["diff", "--binary", previous.tree, tree, "--"], deltaPath);
      const deltaNames = await this.gitOutput(run.cwd, [
        "diff",
        "--name-only",
        "-z",
        previous.tree,
        tree,
        "--",
      ]);
      delta = {
        baseArtifactId: previous.id,
        diffPath: deltaPath,
        changedFiles: deltaNames.split("\0").filter(Boolean),
      };
    }
    return {
      id,
      tree,
      diffPath,
      changedFiles: names.split("\0").filter(Boolean),
      diff: await readPreview(diffPath, 48000),
      capturedAt: Date.now(),
      ...(delta ? { delta } : {}),
    };
  }
  async discard(_evidence: Evidence) {
    // Operation-scoped context files keep citing patches, pinned trees and verification logs.
    // Retain all evidence for the run's lifetime, including after a rework or retry.
  }
  async verify(run: Run, signal: AbortSignal): Promise<Evidence> {
    if (signal.aborted) throw new Error("验证已中止");
    const snapshot = await this.capture(run);
    if (!run.settings.verificationCommands.length) {
      return { ...snapshot, checks: [], passed: false, verificationStatus: "not_configured" };
    }
    const checks: Evidence["checks"] = [];
    for (const command of run.settings.verificationCommands) {
      if (signal.aborted) throw new Error("验证已中止");
      const result = await executeCheck(command, run.cwd, signal);
      const logPath = join(this.root, "artifacts", run.id, `${randomUUID()}.log`);
      await writeFile(logPath, result.output, { mode: 0o600 });
      checks.push({
        label: command.label,
        exitCode: result.exitCode,
        logPath,
        output: result.output.slice(-6000),
      });
    }
    if ((await this.fingerprint(run)) !== snapshot.id)
      throw new Error("验收命令改变了源文件，请使用不修改源文件的验证命令后重试");
    const passed = checks.every((candidateConversation) => candidateConversation.exitCode === 0);
    return { ...snapshot, checks, passed, verificationStatus: passed ? "passed" : "failed" };
  }
}

/** The first `length` characters of a UTF-8 file, reading only as many bytes as they can occupy. */
async function readPreview(path: string, length: number) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length * 4);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(0, length);
  } finally {
    await file.close();
  }
}

export function executeCheck(
  command: Command,
  cwd: string,
  signal: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "",
      finished = false,
      timedOut = false;
    const child = spawn(command.command, command.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (data: Buffer | string) => {
      if (output.length < 262144) output += data.toString().slice(0, 262144 - output.length);
    };
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (timedOut) output += "\n[AI 协作: 验证超时]";
      if (signal.aborted) output += "\n[AI 协作: 验证取消]";
      // The event handlers share an idempotent finish guard above.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve({ exitCode: timedOut || signal.aborted ? null : exitCode, output });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      append(error.message);
      finish(null);
    });
    child.on("close", finish);
  });
}
