import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildWorkspaceAgentActivityIndex } from "./workspace-agent-activity";

function agent(input: {
  id: string;
  workspaceId?: string;
  status?: Agent["status"];
  turn?: Agent["turn"];
  updatedAt: string;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
  pendingPermissionCount?: number;
  archivedAt?: string | null;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
}): Agent {
  return {
    serverId: "host-a",
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    turn:
      input.turn ??
      (input.status === "running"
        ? {
            phase: "open",
            turnId: "turn-1",
            startedAt: null,
            cancellationRequestId: null,
          }
        : { phase: "idle", cancellationRequestId: null }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(input.updatedAt),
    lastUserMessageAt: null,
    lastActivityAt: new Date(input.updatedAt),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `permission-${index}`,
      provider: "codex",
      name: "shell",
      kind: "tool",
      input: {},
    })),
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    requiresAttention: input.requiresAttention,
    attentionReason: input.attentionReason,
    attentionTimestamp: input.attentionTimestamp ? new Date(input.attentionTimestamp) : null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
  };
}

describe("workspace agent activity index", () => {
  it("uses turn liveness for running while preserving protocol lifecycle states", () => {
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "open",
          agent({
            id: "open",
            workspaceId: "workspace-open",
            status: "idle",
            turn: {
              phase: "open",
              turnId: null,
              startedAt: null,
              cancellationRequestId: null,
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
        [
          "idle-error",
          agent({
            id: "idle-error",
            workspaceId: "workspace-error",
            status: "error",
            turn: { phase: "idle", cancellationRequestId: null },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      ]),
    );

    expect(result.get("workspace-open")?.status).toBe("running");
    expect(result.get("workspace-error")?.status).toBe("failed");
  });

  it("keeps the latest active root agent for each workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "older",
          agent({
            id: "older",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "permission",
          agent({
            id: "permission",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:01:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
        [
          "attention",
          agent({
            id: "attention",
            workspaceId: "workspace-b",
            updatedAt: "2026-06-01T10:00:00.000Z",
            attentionTimestamp: "2026-06-01T10:02:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "permission",
            status: "needs_input",
            enteredAt: new Date("2026-06-01T10:01:00.000Z"),
          },
        ],
        [
          "workspace-b",
          {
            agentId: "attention",
            status: "attention",
            enteredAt: new Date("2026-06-01T10:02:00.000Z"),
          },
        ],
      ]),
    );
  });

  it("does not let archived or child agents change root workspace activity", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:03:00.000Z",
            pendingPermissionCount: 1,
            parentAgentId: "root",
          }),
        ],
        [
          "archived",
          agent({
            id: "archived",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:04:00.000Z",
            requiresAttention: true,
            attentionReason: "error",
            archivedAt: "2026-06-01T10:04:00.000Z",
          }),
        ],
      ]),
    );

    expect(index.get("workspace-a")).toEqual({
      agentId: "root",
      status: "running",
      enteredAt: new Date("2026-06-01T10:00:00.000Z"),
    });
  });

  it("shows the main workspace as running while its collaboration child is working", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "main",
          agent({
            id: "main",
            workspaceId: "workspace-main",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "worker",
          agent({
            id: "worker",
            workspaceId: "workspace-main",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "main",
            labels: { "director-run": "run-1", "director-role": "worker" },
          }),
        ],
      ]),
    );

    expect(index.get("workspace-main")).toEqual({
      agentId: "main",
      status: "running",
      enteredAt: new Date("2026-06-01T10:03:00.000Z"),
    });
  });

  it("attributes a collaboration worktree child to the main workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "main",
          agent({
            id: "main",
            workspaceId: "workspace-main",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "worker",
          agent({
            id: "worker",
            workspaceId: "workspace-worktree",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "main",
            labels: { "director-run": "run-1", "director-role": "worker" },
          }),
        ],
      ]),
    );

    expect(index.get("workspace-main")?.status).toBe("running");
    expect(index.get("workspace-worktree")?.status).toBe("running");
  });

  it("keeps a more urgent main-workspace state ahead of a running collaboration child", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "main",
          agent({
            id: "main",
            workspaceId: "workspace-main",
            updatedAt: "2026-06-01T10:04:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
        [
          "worker",
          agent({
            id: "worker",
            workspaceId: "workspace-main",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "main",
            labels: { "director-run": "run-1", "director-role": "reviewer" },
          }),
        ],
      ]),
    );

    expect(index.get("workspace-main")?.status).toBe("needs_input");
  });

  it("does not keep the main workspace running after the collaboration child finishes", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "main",
          agent({
            id: "main",
            workspaceId: "workspace-main",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "worker",
          agent({
            id: "worker",
            workspaceId: "workspace-main",
            status: "idle",
            updatedAt: "2026-06-01T10:05:00.000Z",
            parentAgentId: "main",
            labels: { "director-run": "run-1", "director-role": "worker" },
          }),
        ],
      ]),
    );

    expect(index.get("workspace-main")?.status).toBe("done");
  });

  it.each([
    { status: "running", expected: "running" },
    { status: "idle", expected: "done" },
  ] as const)(
    "ignores a replaced failed collaboration child when its replacement is $status",
    ({ status, expected }) => {
      const main = agent({
        id: "main",
        workspaceId: "workspace-main",
        updatedAt: "2026-06-01T10:00:00.000Z",
      });
      const failed = agent({
        id: "failed-worker",
        workspaceId: "workspace-worktree",
        status: "error",
        updatedAt: "2026-06-01T10:01:00.000Z",
        parentAgentId: main.id,
        labels: { "director-run": "run-1", "director-role": "worker" },
      });
      const replacement = agent({
        id: "replacement-worker",
        workspaceId: "workspace-worktree",
        status,
        updatedAt: "2026-06-01T10:02:00.000Z",
        parentAgentId: main.id,
        labels: { "director-run": "run-1", "director-role": "worker" },
      });
      const index = buildWorkspaceAgentActivityIndex(
        new Map([main, failed, replacement].map((entry) => [entry.id, entry])),
      );

      expect(index.get("workspace-main")?.status).toBe(expected);
      expect(index.get("workspace-worktree")?.status).toBe(expected);
    },
  );

  it("keeps a collaboration child's unread completion in its subagents track", () => {
    const main = agent({
      id: "main",
      workspaceId: "workspace-main",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });
    const child = agent({
      id: "worker",
      workspaceId: "workspace-main",
      updatedAt: "2026-06-01T10:01:00.000Z",
      parentAgentId: main.id,
      requiresAttention: true,
      attentionReason: "finished",
      labels: { "director-run": "run-1", "director-role": "worker" },
    });

    expect(
      buildWorkspaceAgentActivityIndex(
        new Map([main, child].map((entry) => [entry.id, entry])),
      ).get("workspace-main")?.status,
    ).toBe("done");
  });

  it("treats a cross-workspace subagent as activity in its own workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "parent",
          agent({
            id: "parent",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-b",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "parent",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "parent",
            status: "done",
            enteredAt: new Date("2026-06-01T10:00:00.000Z"),
          },
        ],
        [
          "workspace-b",
          {
            agentId: "child",
            status: "running",
            enteredAt: new Date("2026-06-01T10:03:00.000Z"),
          },
        ],
      ]),
    );
  });

  it("preserves the activity index while the same agent remains in the same status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:05:00.000Z",
          }),
        ],
      ]),
      previous,
    );

    expect(next).toBe(previous);
    expect(next.get("workspace-a")?.enteredAt).toEqual(new Date("2026-06-01T10:00:00.000Z"));
  });

  it("records a new entry time when an agent changes status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "idle",
            updatedAt: "2026-06-01T10:05:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
      ]),
      previous,
    );

    expect(next).not.toBe(previous);
    expect(next.get("workspace-a")).toEqual({
      agentId: "root",
      status: "needs_input",
      enteredAt: new Date("2026-06-01T10:05:00.000Z"),
    });
  });
});
