import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { migrateNativeCollaboration } from "./migration.js";
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { harness, plan } from "./test-utils/harness.js";

test("pending plan approval survives restart without recreating the planning session", async (t) => {
  const h = await harness({ requirePlanApproval: true });
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  await h.complete(plan);
  const original = { ...h.run(), workspaceId: "original-workspace" };
  h.store.save(original);
  for (let i = 0; i < 30; i++)
    h.store.insert({
      ...original,
      id: `other-${i}`,
      requestId: `other-${i}`,
      workspaceId: "other-workspace",
    });
  h.store.insert({
    ...original,
    id: "newer-canceled",
    requestId: "newer-canceled",
    control: "canceled",
  });
  await h.restart();
  assert.equal(h.run().planApproved, false);
  assert.equal(h.run().control, "paused");
  assert.equal(h.agents.created.length, 1);
});

test("native migration retains checkpoints, pauses uncertain delivery and is idempotent", async (t) => {
  const h = await harness();
  t.onTestFinished(() => h.cleanup());
  await h.until("plan");
  const original = h.run();
  original.operations.at(-1)!.state = "sending";
  h.store.save(original);
  migrateNativeCollaboration(h.store);
  expect(h.run().control).toBe("needs_attention");
  expect(h.run().operations).toEqual(original.operations);
  expect(h.run().directorAgentId).toBe(original.directorAgentId);
  const checkpoint = h.run();
  migrateNativeCollaboration(h.store);
  expect(h.run()).toEqual(checkpoint);
});

test("a second writer in the same process cannot take the native database lock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "collaboration-owner-"));
  const path = join(directory, "director.sqlite");
  const store = new Store(path);
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  expect(() => new Store(path)).toThrow("另一个 AI 协作实例");
});
