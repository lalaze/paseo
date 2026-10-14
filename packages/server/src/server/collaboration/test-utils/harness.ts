import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsSchema,
  type Run,
  type Operation,
  type Profile,
  type Evidence,
  type Plan,
  type CollaborationMode,
  type ExecutionModel,
} from "@getpaseo/protocol/collaboration/schema";
import { Engine, type AgentGateway, type AgentSnapshot } from "../engine.js";
import { Store } from "../store.js";
import type { Repository } from "../repository.js";

export const settings = () =>
  SettingsSchema.parse({
    profiles: [
      { id: "lead", label: "总 AI", provider: "vendor-a/model-a" },
      { id: "worker", label: "执行 AI", provider: "vendor-b/model-b" },
    ],
    directorProfileId: "lead",
    workerProfileId: "worker",
    verificationCommands: [{ label: "test", command: "npm", args: ["test"] }],
  });
export const reviewerSettings = () =>
  SettingsSchema.parse({
    ...settings(),
    profiles: [
      ...settings().profiles,
      {
        id: "audit",
        label: "审核 AI",
        provider: "vendor-c/model-c",
        modeId: "auto-review",
        thinkingOptionId: "high",
        transport: "mcp",
      },
    ],
    reviewerProfileId: "audit",
  });
export const plan: Plan = {
  summary: "实现功能",
  architecture: "模块接口",
  acceptance: ["完整功能可用"],
  tasks: [
    {
      id: "task-1",
      title: "实现",
      description: "实现接口",
      category: "backend",
      dependsOn: [],
      files: ["src/**"],
      acceptance: ["接口测试通过"],
    },
  ],
};
export const result = {
  status: "ready_for_review",
  summary: "实现完毕",
  tests: ["npm test"],
  issues: [],
};
export const review = (final = false, decision = "approved") => ({
  decision,
  artifactId: "artifact-v1",
  summary: "审核结论",
  criteria: (final ? ["完整功能可用", "接口测试通过"] : ["接口测试通过"]).map((criterion) => ({
    criterion,
    passed: decision === "approved",
    evidence: "代码和测试记录",
  })),
  findings:
    decision === "changes_requested"
      ? [
          {
            taskId: "task-1",
            location: "src/api.ts:10",
            problem: "遗漏空值",
            change: "增加空值处理",
            verification: "增加空值用例",
          },
        ]
      : [],
});

export class FakeAgents implements AgentGateway {
  directory = "/repo";
  async workspaceDirectory(_workspaceId: string) {
    return this.directory;
  }
  async retainWorkspaceName(_workspaceId: string) {}
  created: { id: string; runId: string; opId: string; profile: Profile }[] = [];
  sent: { agentId: string; opId: string; prompt: string }[] = [];
  states = new Map<string, AgentSnapshot>();
  stopped: string[] = [];
  invalidModels = new Set<string>();
  holdInFlight = new Set<string>();
  stopError: string | undefined;
  activities = new Map<string, { text: string; truncated?: boolean; missing?: boolean }>();
  pendingSendErrors: { message: string; inFlight?: boolean }[] = [];
  pendingCreateErrors: { message: string; inFlight?: boolean }[] = [];
  /** The next find calls return two ids, so creation stays ambiguous. */
  ambiguousFinds = 0;
  /** Throw on the inspect that follows this many successful reads. 0 disables it. */
  inspectThrowsAfter = 0;
  successfulInspects = 0;
  async create(run: Run, op: Operation, profile: Profile) {
    const pending = this.pendingCreateErrors.shift();
    if (pending) {
      if (pending.inFlight) this.recordBusy(run, op, profile, pending.message);
      throw new Error(pending.message);
    }
    const id = `agent-${this.created.length + 1}`;
    this.created.push({ id, runId: run.id, opId: op.id, profile });
    this.states.set(id, { status: "idle", seen: false, output: "" });
    return id;
  }
  private recordBusy(run: Run, op: Operation, profile: Profile, message: string) {
    const id = `agent-${this.created.length + 1}`;
    this.created.push({ id, runId: run.id, opId: op.id, profile });
    this.states.set(id, {
      status: "error",
      seen: true,
      output: "",
      error: message,
      ownership: { inFlight: true, pendingPermissions: 0, lifecycle: "error" },
    });
    this.holdInFlight.add(id);
  }
  async find(runId: string, operationId: string) {
    if (this.ambiguousFinds > 0) {
      this.ambiguousFinds -= 1;
      return ["ghost-a", "ghost-b"];
    }
    return this.created.filter((a) => a.runId === runId && a.opId === operationId).map((a) => a.id);
  }
  async inspect(agentId: string) {
    if (this.inspectThrowsAfter > 0 && this.successfulInspects >= this.inspectThrowsAfter) {
      this.inspectThrowsAfter = 0;
      throw new Error("无法读取会话状态");
    }
    this.successfulInspects += 1;
    return this.states.get(agentId) ?? { status: "missing" as const, seen: false, output: "" };
  }
  async send(agentId: string, opId: string, prompt: string) {
    const pending = this.pendingSendErrors.shift();
    if (pending) {
      if (pending.inFlight) {
        this.sent.push({ agentId, opId, prompt });
        this.states.set(agentId, {
          status: "error",
          seen: true,
          output: "",
          error: pending.message,
          ownership: { inFlight: true, pendingPermissions: 0, lifecycle: "error" },
        });
        this.holdInFlight.add(agentId);
      }
      throw new Error(pending.message);
    }
    this.sent.push({ agentId, opId, prompt });
    this.states.set(agentId, { status: "running", seen: true, output: "" });
  }
  async stop(agentId: string) {
    this.stopped.push(agentId);
    if (this.stopError) throw new Error(this.stopError);
    const previous = this.states.get(agentId);
    if (this.holdInFlight.has(agentId)) {
      this.states.set(agentId, {
        status: "error",
        seen: true,
        output: previous?.output ?? "",
        error: previous?.error,
        ownership: { inFlight: true, pendingPermissions: 0, lifecycle: "error" },
      });
      return;
    }
    this.states.set(agentId, {
      status: "idle",
      seen: previous?.seen ?? true,
      output: previous?.output ?? "",
      error: previous?.error,
      ownership: { inFlight: false, pendingPermissions: 0, lifecycle: "idle" },
    });
  }
  async validateExecutionModel(model: ExecutionModel) {
    if (this.invalidModels.has(model.provider)) throw new Error(`模型不可用：${model.provider}`);
  }
  async handoffActivity(agentId: string) {
    return (
      this.activities.get(agentId) ?? {
        text: "[Assistant] 已修改 src/api.ts，npm test 已报告但未在交接中复跑",
        truncated: false,
        missing: false,
      }
    );
  }
}
export class FakeRepository implements Repository {
  async assertBranch(_run: Run) {}
  version = "artifact-v1";
  passed = true;
  verifications = 0;
  discarded: Evidence[] = [];
  merges = 0;
  mergeError: Error | null = null;
  unmergedFiles: string[] = [];
  prepares = 0;
  changes: {
    paths: string[];
    diff: string;
    missing?: boolean;
    truncated?: boolean;
    pathCount?: number;
  } = {
    paths: ["src/api.ts"],
    diff: "diff --git a/src/api.ts\n+export const api = 1;\n",
  };
  async mergeRecoveryContext(run: Run) {
    if (run.delivery?.status !== "failed") throw new Error("No failed merge");
    return {
      repository: run.repository,
      cwd: run.cwd,
      branch: run.branch,
      targetBranch: run.sourceBranch!,
      targetCwd: run.repository,
      currentBranch: run.branch,
      artifactId: run.finalEvidence!.id,
      error: run.delivery.error,
      changedFiles: run.finalEvidence!.changedFiles,
      verificationCommands: run.settings.verificationCommands,
      sourceStatus: "",
      targetStatus: "",
      unmergedFiles: this.unmergedFiles,
    };
  }
  async mergeAccepted(run: Run) {
    this.merges++;
    if (this.mergeError) throw this.mergeError;
    return {
      status: "merged" as const,
      targetBranch: run.sourceBranch!,
      cwd: run.repository,
      commit: "delivered-commit",
    };
  }
  async fingerprint() {
    return this.version;
  }
  async discard(evidence: Evidence) {
    this.discarded.push(evidence);
  }
  async prepare(repository: string, runId: string, currentWorkspace = false) {
    this.prepares++;
    return {
      repository,
      cwd: currentWorkspace ? repository : `/worktrees/${runId}`,
      baseCommit: "base",
      branch: `director/${runId}`,
      sourceBranch: "main",
    };
  }
  async workingChanges() {
    return this.changes;
  }
  async capture() {
    return {
      id: this.version,
      tree: "tree",
      diffPath: "/artifacts/code.patch",
      changedFiles: ["src/api.ts"],
      diff: "diff",
      capturedAt: 1,
    };
  }
  async verify(run: Run): Promise<Evidence> {
    this.verifications++;
    if (!run.settings.verificationCommands.length)
      return {
        ...(await this.capture()),
        checks: [],
        passed: false,
        verificationStatus: "not_configured",
      };
    return {
      ...(await this.capture()),
      checks: [
        {
          label: "test",
          exitCode: this.passed ? 0 : 1,
          output: "test log",
          logPath: "/artifacts/test.log",
        },
      ],
      passed: this.passed,
    };
  }
}
export async function harness(overrides = {}, mode?: CollaborationMode) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "director-engine-")));
  let store = new Store(join(directory, "db.sqlite"));
  const agents = new FakeAgents(),
    repository = new FakeRepository();
  let now = Date.now(),
    engine = new Engine(store, agents, repository, () => now);
  const id = await engine.create({
    requestId: "request-1",
    repository: "/repo",
    goal: "实现新功能",
    mode,
    settings: SettingsSchema.parse({ ...settings(), ...overrides }),
  });
  return {
    id,
    directory,
    agents,
    repository,
    get engine() {
      return engine;
    },
    get store() {
      return store;
    },
    run: () => store.get(id),
    op: () => {
      const run = store.get(id);
      return run.operations.find((o) => o.id === run.activeOperationId);
    },
    elapse(ms: number) {
      now += ms;
    },
    async until(kind: Operation["kind"]) {
      for (let i = 0; i < 40; i++) {
        const run = store.get(id),
          op = run.operations.find((o) => o.id === run.activeOperationId);
        if (op?.kind === kind && op.state === "sent") return op;
        await engine.tick();
      }
      const run = store.get(id);
      throw new Error(`没有到达 ${kind}: ${run.phase}/${run.control}: ${run.message}`);
    },
    async complete(payload: unknown) {
      const run = store.get(id),
        op = run.operations.find((o) => o.id === run.activeOperationId)!;
      agents.states.set(op.agentId!, {
        status: "idle",
        seen: true,
        output: JSON.stringify(payload),
      });
      await engine.tick();
    },
    async restart() {
      await engine.close();
      store.close();
      store = new Store(join(directory, "db.sqlite"));
      engine = new Engine(store, agents, repository, () => now);
    },
    async cleanup() {
      await engine.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
