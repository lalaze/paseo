import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("personal runtime is independent of the checkout and rejects external dependency links", async (t) => {
  const { copyRuntime } = await import("./deploy-personal.mjs");
  const directory = await mkdtemp(join(tmpdir(), "paseo-personal-copy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const destination = join(directory, "runtime");
  await mkdir(join(source, "packages/server"), { recursive: true });
  await mkdir(join(source, "node_modules/@getpaseo"), { recursive: true });
  await writeFile(join(source, "packages/server/index.js"), "original");
  await symlink(join(source, "packages/server"), join(source, "node_modules/@getpaseo/server"));
  await copyRuntime({
    source,
    destination,
    files: ["node_modules/@getpaseo/server", "packages/server/index.js"],
  });
  await writeFile(join(source, "packages/server/index.js"), "changed");
  assert.equal(
    await readFile(join(destination, "node_modules/@getpaseo/server/index.js"), "utf8"),
    "original",
  );
  assert.equal(
    await realpath(join(destination, "node_modules/@getpaseo/server")),
    join(await realpath(destination), "packages/server"),
  );
  await symlink(directory, join(source, "external"));
  await assert.rejects(copyRuntime({ source, destination, files: ["external"] }), /External link/);
});

async function personalDeployment(t) {
  const root = await mkdtemp(join(tmpdir(), "paseo-personal-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const oldRelease = join(root, "releases/old");
  const release = join(root, "releases/new");
  const oldEntry = join(oldRelease, "packages/cli/dist/index.js");
  const entry = join(release, "packages/cli/dist/index.js");
  await mkdir(oldRelease, { recursive: true });
  await mkdir(release, { recursive: true });
  await symlink("releases/old", join(root, "current"));
  const state = { home, active: { entry: oldEntry, release: oldRelease }, previous: null };
  await writeFile(join(root, "deployment.json"), JSON.stringify(state));
  const calls = [];
  const runtime = { running: oldEntry, failStart: false, failHealth: false, failStop: false };
  async function invoke(target, args) {
    calls.push([target, args[0]]);
    assert.deepEqual(args.slice(1, 3), ["--home", home]);
    if (args[0] === "status") {
      return JSON.stringify({
        localDaemon: runtime.running ? "running" : "stopped",
        connectedDaemon:
          runtime.failHealth && runtime.running === entry ? "unreachable" : "reachable",
        desktopManaged: false,
      });
    }
    if (args[0] === "stop") {
      if (runtime.failStop) throw new Error("stop failed");
      runtime.running = null;
      return "";
    }
    assert.equal(args[0], "start");
    runtime.running = target;
    if (runtime.failStart && target === entry) throw new Error("start failed");
    return "";
  }
  return { root, home, release, oldRelease, oldEntry, entry, state, calls, runtime, invoke };
}

test("personal deployment switches only after health checks and records the previous runtime", async (t) => {
  const { activate } = await import("./deploy-personal.mjs");
  const fixture = await personalDeployment(t);
  await activate(fixture);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/new");
  const state = JSON.parse(await readFile(join(fixture.root, "deployment.json"), "utf8"));
  assert.deepEqual(state.previous, fixture.state.active);
  assert.equal(fixture.runtime.running, fixture.entry);
  assert.deepEqual(fixture.calls, [
    [fixture.entry, "status"],
    [fixture.oldEntry, "stop"],
    [fixture.entry, "start"],
    [fixture.entry, "status"],
  ]);
  await activate({ ...fixture, release: state.previous.release });
  assert.equal(fixture.runtime.running, fixture.oldEntry);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/old");
  const rolledBack = JSON.parse(await readFile(join(fixture.root, "deployment.json"), "utf8"));
  await activate({ ...fixture, release: fixture.oldRelease });
  const reactivated = JSON.parse(await readFile(join(fixture.root, "deployment.json"), "utf8"));
  assert.deepEqual(reactivated.previous, rolledBack.previous);
});

for (const failure of ["failStart", "failHealth"]) {
  test(`personal deployment restores the old daemon after ${failure}`, async (t) => {
    const { activate } = await import("./deploy-personal.mjs");
    const fixture = await personalDeployment(t);
    fixture.runtime[failure] = true;
    await assert.rejects(activate(fixture), /start failed|not reachable/);
    assert.equal(fixture.runtime.running, fixture.oldEntry);
    assert.equal(await readlink(join(fixture.root, "current")), "releases/old");
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.root, "deployment.json"), "utf8")),
      fixture.state,
    );
    assert.deepEqual(fixture.calls.slice(-3), [
      [fixture.entry, "stop"],
      [fixture.oldEntry, "start"],
      [fixture.oldEntry, "status"],
    ]);
  });
}

test("personal deployment never starts a replacement after failed shutdown", async (t) => {
  const { activate } = await import("./deploy-personal.mjs");
  const fixture = await personalDeployment(t);
  fixture.runtime.failStop = true;
  await assert.rejects(activate(fixture), /stop failed/);
  assert.equal(fixture.runtime.running, fixture.oldEntry);
  assert.deepEqual(fixture.calls, [
    [fixture.entry, "status"],
    [fixture.oldEntry, "stop"],
  ]);
});

test("first migration requires the old CLI before stopping an existing daemon", async (t) => {
  const { activate } = await import("./deploy-personal.mjs");
  const fixture = await personalDeployment(t);
  await rm(join(fixture.root, "deployment.json"));
  await assert.rejects(activate(fixture), /--previous-cli/);
  assert.equal(fixture.runtime.running, fixture.oldEntry);
  assert.deepEqual(fixture.calls, [[fixture.entry, "status"]]);
});

test("two-host source snapshots include current edits and new files but exclude ignored files and deletions", async (t) => {
  const { sourceSnapshot, shellQuote } = await import("./deploy-personal-targets.mjs");
  const root = await mkdtemp(join(tmpdir(), "paseo-source-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), ".env\nnode_modules/\n");
  await writeFile(join(root, "removed.txt"), "removed");
  execFileSync("git", ["-C", root, "add", "."]);
  await rm(join(root, "removed.txt"));
  await writeFile(join(root, ".env"), "private configuration");
  await writeFile(join(root, "new file.txt"), "first");
  const before = await sourceSnapshot(root);
  assert.deepEqual(before.files, [".gitignore", "new file.txt"]);
  await writeFile(join(root, "new file.txt"), "second");
  const after = await sourceSnapshot(root);
  assert.notEqual(before.sourceId, after.sourceId);
  assert.deepEqual(after, await sourceSnapshot(root, after.files));
  await assert.rejects(sourceSnapshot(root, ["../outside"]), /Invalid source path/);
  const unusual = "path with spaces'$(printf injected)\nlast line";
  assert.equal(
    execFileSync("sh", ["-c", `printf '%s' ${shellQuote(unusual)}`], { encoding: "utf8" }),
    unusual,
  );
});

function twoHostDeployment(failAt) {
  const events = [];
  function target(name) {
    return {
      async prepare() {
        events.push(`${name}:prepare`);
        if (failAt === `${name}:prepare`) throw new Error(failAt);
      },
      async activate() {
        events.push(`${name}:activate`);
        if (failAt === `${name}:activate`) throw new Error(failAt);
      },
    };
  }
  return { events, local: target("local"), code: target("code") };
}

test("two-host deployment verifies both builds and activates the local daemon last", async () => {
  const { deployBoth } = await import("./deploy-personal-targets.mjs");
  const targets = twoHostDeployment();
  await deployBoth(targets);
  assert.deepEqual(targets.events, [
    "local:prepare",
    "code:prepare",
    "code:activate",
    "local:activate",
  ]);
});

test("prepare-only never switches either live daemon", async () => {
  const { deployBoth } = await import("./deploy-personal-targets.mjs");
  const targets = twoHostDeployment();
  await deployBoth({ ...targets, prepareOnly: true });
  assert.deepEqual(targets.events, ["local:prepare", "code:prepare"]);
});

for (const target of ["local", "code"]) {
  test(`a failed ${target} preparation leaves both live daemons untouched`, async () => {
    const { deployBoth } = await import("./deploy-personal-targets.mjs");
    const targets = twoHostDeployment(`${target}:prepare`);
    await assert.rejects(deployBoth(targets), /neither daemon was switched/);
    assert.deepEqual(targets.events, ["local:prepare", "code:prepare"]);
  });
}

test("failed remote activation never restarts the local daemon", async () => {
  const { deployBoth } = await import("./deploy-personal-targets.mjs");
  const targets = twoHostDeployment("code:activate");
  await assert.rejects(deployBoth(targets), /code:activate/);
  assert.deepEqual(targets.events, ["local:prepare", "code:prepare", "code:activate"]);
});

test("failed local activation reports that the remote host already switched", async () => {
  const { deployBoth } = await import("./deploy-personal-targets.mjs");
  const targets = twoHostDeployment("local:activate");
  await assert.rejects(deployBoth(targets), /code was updated, but local activation failed/);
  assert.deepEqual(targets.events, [
    "local:prepare",
    "code:prepare",
    "code:activate",
    "local:activate",
  ]);
});
