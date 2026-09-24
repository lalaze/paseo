#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import { isMainModule } from "./is-main-module.mjs";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const cliPath = "packages/cli/dist/index.js";

async function run(command, args, options = {}) {
  const child = exec(command, args, {
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  child.child.stderr.pipe(process.stderr);
  if (!options.capture) child.child.stdout.pipe(process.stdout);
  return (await child).stdout;
}

async function optionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveJson(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temporary, file);
}

export async function replaceLink(link, target) {
  const temporary = `${link}.${process.pid}.tmp`;
  await symlink(target, temporary);
  try {
    await rename(temporary, link);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Preserve the traced workspace links, but never let a release resolve back into
// the mutable checkout (including when npm created an absolute workspace link).
export async function copyRuntime({ source, destination, files }) {
  for (const file of files) {
    const from = path.resolve(source, file);
    const relative = path.relative(source, from);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const to = path.join(destination, relative);
    const info = await lstat(from);
    await mkdir(path.dirname(to), { recursive: true });
    if (info.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(from), await readlink(from));
      const target = path.relative(source, resolved);
      assert.ok(!target.startsWith("..") && !path.isAbsolute(target), `External link: ${file}`);
      await symlink(path.relative(path.dirname(to), path.join(destination, target)), to);
    } else if (info.isDirectory()) {
      await mkdir(to, { recursive: true });
    } else {
      // APFS clones avoid copying unchanged dependency bytes on every local deploy.
      await copyFile(from, to, constants.COPYFILE_FICLONE);
    }
  }
}

async function daemon(entry, args, capture = false) {
  return run(process.execPath, [entry, "daemon", ...args], {
    capture,
    env: { ...process.env, PASEO_NODE_ENV: "production" },
  });
}

async function assertHealthy(entry, home, invoke) {
  const status = JSON.parse(await invoke(entry, ["status", "--home", home, "--json"], true));
  assert.equal(status.connectedDaemon, "reachable", "New daemon is not reachable");
}

export async function verifyRuntime(release) {
  const home = await mkdtemp(path.join(release, ".smoke-"));
  const entry = path.join(release, cliPath);
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
      features: { webUi: { enabled: true } },
    }),
  );
  try {
    await daemon(entry, ["start", "--home", home, "--timeout", "60"]);
    await assertHealthy(entry, home, daemon);
    const instance = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
    const response = await fetch(`http://${instance.listen}/`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/);
  } finally {
    await daemon(entry, ["stop", "--home", home]);
    await rm(home, { recursive: true });
  }
}

async function prepare(root, sourceInfo) {
  await run("npm", ["run", "build:server"]);
  await run("npm", ["run", "build:daemon-web-ui"]);
  const source = sourceInfo ? JSON.parse(await readFile(sourceInfo, "utf8")) : null;
  const commit =
    source?.commit ?? (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
  const dirty =
    source?.dirty ??
    Boolean((await run("git", ["status", "--porcelain"], { capture: true })).trim());
  const id = `${commit.slice(0, 12)}-${Date.now()}`;
  const release = path.join(root, "releases", id);
  await mkdir(release, { recursive: true });
  process.stdout.write(
    `Preparing runtime ${id}${dirty ? " (working tree changes included)" : ""}\n`,
  );
  const traced = await run(process.execPath, ["scripts/trace-daemon.mjs"], {
    capture: true,
    env: { ...process.env, PASEO_TRACE_DESKTOP: "0" },
  });
  const files = new Set([...traced.trim().split("\n"), "package.json", "LICENSE"]);
  await copyRuntime({ source: repo, destination: release, files });
  await cp(
    path.join(repo, "packages/server/dist/server/web-ui"),
    path.join(release, "packages/server/dist/server/web-ui"),
    { recursive: true, mode: constants.COPYFILE_FICLONE },
  );
  await verifyRuntime(release);
  const metadata = {
    release,
    commit,
    dirty,
    sourceId: source?.sourceId ?? null,
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
    preparedAt: new Date().toISOString(),
  };
  await saveJson(path.join(release, "personal-release.json"), metadata);
  await saveJson(path.join(root, "prepared.json"), metadata);
  process.stdout.write(`Verified: ${release}\n`);
  return release;
}

// invoke is the daemon CLI boundary. Filesystem transitions remain real in tests.
export async function activate({ root, release, home, previousCli, invoke = daemon }) {
  const statePath = path.join(root, "deployment.json");
  const state = await optionalJson(statePath);
  if (state) assert.equal(state.home, home, "Use the same --home for this deployment root");
  const entry = path.join(release, cliPath);
  const previous = state?.active ?? (previousCli ? { entry: previousCli, release: null } : null);
  const status = JSON.parse(await invoke(entry, ["status", "--home", home, "--json"], true));
  assert.notEqual(
    status.desktopManaged,
    true,
    "Desktop-managed daemons must be updated in Desktop",
  );
  const wasRunning = status.localDaemon !== "stopped";
  assert.ok(!wasRunning || previous, "First migration requires --previous-cli <old dist/index.js>");
  const rollback = state?.active.release === release ? state.previous : previous;
  const control = previous?.entry ?? entry;
  // A failed stop must never be followed by starting a second supervisor.
  await invoke(control, ["stop", "--home", home]);
  try {
    await invoke(entry, ["start", "--home", home, "--timeout", "60"]);
    await assertHealthy(entry, home, invoke);
    await replaceLink(path.join(root, "current"), path.relative(root, release));
    await saveJson(statePath, { home, active: { entry, release }, previous: rollback });
  } catch (error) {
    await invoke(entry, ["stop", "--home", home]);
    if (previous && wasRunning) {
      await invoke(previous.entry, ["start", "--home", home, "--timeout", "60"]);
      await assertHealthy(previous.entry, home, invoke);
    }
    if (state?.active.release) {
      await replaceLink(path.join(root, "current"), path.relative(root, state.active.release));
    } else {
      await rm(path.join(root, "current"), { force: true });
    }
    throw error;
  }
  process.stdout.write(`Active: ${release}\nCLI: ${path.join(root, "bin/paseo")}\n`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: path.join(repo, "artifacts/personal") },
      home: { type: "string" },
      "previous-cli": { type: "string" },
      "source-info": { type: "string" },
      release: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout
      .write(`Usage: npm run deploy:personal -- [prepare|deploy|activate|rollback] [options]
  prepare   Build and verify a runtime without changing the running daemon (default)
  deploy    Prepare, then stop/start the target daemon and activate the runtime
  activate  Activate the last successfully prepared runtime without rebuilding
  rollback  Activate the previous personal runtime without rebuilding
  --root <directory>       Runtime storage (default: artifacts/personal)
  --home <directory>       Required for deploy, activate and rollback
  --previous-cli <file>    Old CLI dist/index.js for rollback on first migration
  --source-info <file>     Source identity supplied by deploy:all
  --release <directory>    Activate this verified runtime instead of the latest prepared one

Run on the target machine with dependencies installed. Native dependencies are host-specific.
deploy/activate/rollback stop the full supervisor, interrupting its running agents.
`);
    return;
  }
  const [action = "prepare"] = positionals;
  assert.ok(
    positionals.length <= 1 && ["prepare", "deploy", "activate", "rollback"].includes(action),
  );
  assert.ok(
    action === "prepare" || values.home,
    "Specify --home explicitly before restarting a daemon",
  );
  assert.notEqual(process.platform, "win32", "Personal deployment supports macOS and Linux");
  const root = path.resolve(values.root);
  await mkdir(root, { recursive: true });
  const lock = path.join(root, ".deploy-lock");
  await mkdir(lock);
  try {
    await mkdir(path.join(root, "bin"), { recursive: true });
    await replaceLink(path.join(root, "bin/paseo"), "../current/packages/cli/bin/paseo");
    if (action === "prepare" || action === "deploy") await prepare(root, values["source-info"]);
    if (action === "prepare") {
      process.stdout.write(
        "Ready. Use activate --home <daemon-home> when you can interrupt the daemon.\n",
      );
      return;
    }
    assert.ok(!values.release || action === "activate", "--release requires activate");
    const metadataPath = values.release
      ? path.join(path.resolve(values.release), "personal-release.json")
      : path.join(root, "prepared.json");
    let metadata = await optionalJson(metadataPath);
    if (action === "rollback") {
      const state = await optionalJson(path.join(root, "deployment.json"));
      assert.ok(
        state?.previous?.release,
        "No previous personal runtime; use the original npm CLI for the first migration",
      );
      metadata = await optionalJson(path.join(state.previous.release, "personal-release.json"));
    }
    assert.ok(metadata, "Prepare a runtime first");
    assert.equal(metadata.platform, process.platform);
    assert.equal(metadata.arch, process.arch);
    assert.equal(
      metadata.nodeAbi,
      process.versions.modules,
      "Node ABI changed; prepare a new runtime",
    );
    await activate({
      root,
      release: metadata.release,
      home: path.resolve(values.home),
      previousCli: values["previous-cli"] ? path.resolve(values["previous-cli"]) : undefined,
    });
  } finally {
    await rm(lock, { recursive: true });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
