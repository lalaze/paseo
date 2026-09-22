import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");

function assertNoDirectWorkerLaunch(label, command) {
  for (const workerEntrypoint of [
    "src/server/index.ts",
    "dist/server/server/index.js",
    "src/server/daemon-worker.ts",
    "dist/server/server/daemon-worker.js",
  ]) {
    assert.ok(
      !command.includes(workerEntrypoint),
      `${label} must not launch ${workerEntrypoint} directly: ${command}`,
    );
  }
}

function assertNoSpawnedWorkerEntrypoint(label, source) {
  assertNoDirectWorkerLaunch(label, source);
  assert.doesNotMatch(
    source,
    /spawn\([^)]*["'`][^"'`]*\.\.\/index\.ts["'`]/s,
    `${label} must not spawn ../index.ts directly`,
  );
}

test("every executable daemon entrypoint enters the supervisor", async () => {
  const [
    serverPackageSource,
    appIsolatedHostDaemon,
    serverConnectionOfferE2e,
    desktopRuntimePaths,
    nixPackage,
    nixModule,
  ] = await Promise.all([
    readFile(join(repoRoot, "packages/server/package.json"), "utf8"),
    readFile(join(repoRoot, "packages/app/e2e/support/helpers/isolated-host-daemon.ts"), "utf8"),
    readFile(
      join(repoRoot, "packages/server/src/server/daemon-e2e/connection-offer.e2e.test.ts"),
      "utf8",
    ),
    readFile(join(repoRoot, "packages/desktop/src/daemon/runtime-paths.ts"), "utf8"),
    readFile(join(repoRoot, "nix/package.nix"), "utf8"),
    readFile(join(repoRoot, "nix/module.nix"), "utf8"),
  ]);

  const serverPackage = JSON.parse(serverPackageSource);
  const startScript = serverPackage.scripts?.start ?? "";
  const devScript = serverPackage.scripts?.dev ?? "";
  const devTsxScript = serverPackage.scripts?.["dev:tsx"] ?? "";

  assert.match(startScript, /dist\/scripts\/supervisor-entrypoint\.js/);
  assertNoDirectWorkerLaunch("server start script", startScript);
  assert.match(devScript, /scripts\/dev-runner\.ts/);
  assertNoDirectWorkerLaunch("server dev script", devScript);
  assert.match(devTsxScript, /scripts\/dev-runner\.ts/);
  assertNoDirectWorkerLaunch("server dev:tsx script", devTsxScript);

  assert.match(
    appIsolatedHostDaemon,
    /spawnTsx\("scripts\/supervisor-entrypoint\.ts", \["--dev"\]/,
  );
  assertNoSpawnedWorkerEntrypoint("app e2e isolated host daemon", appIsolatedHostDaemon);

  assert.match(serverConnectionOfferE2e, /scripts\/supervisor-entrypoint\.ts/);
  assertNoSpawnedWorkerEntrypoint("server daemon e2e process launch", serverConnectionOfferE2e);

  assert.match(desktopRuntimePaths, /"dist", "scripts", "supervisor-entrypoint\.js"/);
  assert.match(desktopRuntimePaths, /"scripts", "supervisor-entrypoint\.ts"/);
  assertNoDirectWorkerLaunch("desktop runtime paths", desktopRuntimePaths);

  assert.match(nixPackage, /dist\/scripts\/supervisor-entrypoint\.js/);
  assertNoDirectWorkerLaunch("Nix package wrapper", nixPackage);
  assert.match(nixPackage, /--set PASEO_NODE_ENV production/);
  assert.doesNotMatch(nixPackage, /--set(-default)?\s+NODE_ENV\b/);
  assert.doesNotMatch(nixModule, /\bNODE_ENV\b\s*=/);
  assert.doesNotMatch(nixModule, /\bPASEO_NODE_ENV\b/);
});

test("fork packages retain SDK imports and pin every internal dependency to the fork", async () => {
  const { forkManifest } = await import("./fork-npm.mjs");
  const original = {
    name: "@getpaseo/plugin",
    version: "0.9.0-beta.2",
    dependencies: { zod: "^4", "@getpaseo/client": "0.9.0-beta.2" },
    peerDependencies: { "@getpaseo/protocol": "0.9.0-beta.2", react: "~19.1.0" },
    scripts: { prepack: "build" },
    devDependencies: { typescript: "^5" },
  };
  const result = forkManifest(original, { scope: "@lalaze", version: "0.9.0-beta.2.lalaze.1" });
  assert.equal(result.name, "@lalaze/paseo-plugin");
  assert.equal(
    result.dependencies["@getpaseo/client"],
    "npm:@lalaze/paseo-client@0.9.0-beta.2.lalaze.1",
  );
  assert.equal(
    result.dependencies["@getpaseo/protocol"],
    "npm:@lalaze/paseo-protocol@0.9.0-beta.2.lalaze.1",
  );
  assert.deepEqual(result.peerDependencies, { react: "~19.1.0" });
  assert.equal(result.dependencies.zod, "^4");
  assert.equal(result.scripts, undefined);
  assert.equal(result.devDependencies, undefined);
  assert.equal(original.dependencies["@getpaseo/client"], "0.9.0-beta.2");
});

test("fork identity rewrites fail when build output changes and reject the upstream scope", async () => {
  const { replaceArtifactIdentity, forkPackageName } = await import("./fork-npm.mjs");
  assert.equal(replaceArtifactIdentity('name === "old"', '"old"', '"new"'), 'name === "new"');
  assert.throws(() => replaceArtifactIdentity("missing", "old", "new"), /exactly one/);
  assert.throws(() => replaceArtifactIdentity("old old", "old", "new"), /exactly one/);
  assert.throws(() => forkPackageName("@getpaseo", "cli"), /own npm scope/);
});
