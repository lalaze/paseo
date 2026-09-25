#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { isMainModule } from "./is-main-module.mjs";
import { quotaPatchSnapshot } from "./personal-quota/install.mjs";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const root = path.join(repo, "artifacts/personal");
const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(command, args, { capture = false } = {}) {
  const child = exec(command, args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
  child.child.stderr.pipe(process.stderr);
  if (!capture) child.child.stdout.pipe(process.stdout);
  return (await child).stdout;
}

function remote(host, script, capture = false) {
  const environment = `set -eo pipefail
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi
export PATH="$HOME/.local/bin:$PATH"
set -u
`;
  return run("ssh", [...sshOptions, host, `bash -c ${shellQuote(environment + script)}`], {
    capture,
  });
}

function remoteNode(host, code, capture = false) {
  return remote(
    host,
    `node --input-type=module <<'PASEO_DEPLOY_NODE'\n${code}\nPASEO_DEPLOY_NODE`,
    capture,
  );
}

export async function sourceSnapshot(directory, files) {
  if (!files) {
    const { stdout } = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: directory },
    );
    files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
  }
  const hash = createHash("sha256");
  const present = [];
  for (const file of files) {
    assert.ok(
      file && !path.isAbsolute(file) && !file.split("/").includes(".."),
      `Invalid source path: ${file}`,
    );
    const from = path.join(directory, file);
    let info;
    try {
      info = await lstat(from);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert.ok(info.isFile() || info.isSymbolicLink(), `Unsupported source: ${file}`);
    const mode = info.isSymbolicLink() ? "link" : String(info.mode & 0o111);
    const bytes = info.isSymbolicLink() ? await readlink(from) : await readFile(from);
    if (info.isSymbolicLink()) {
      const target = path.relative(directory, path.resolve(path.dirname(from), bytes));
      assert.ok(
        !path.isAbsolute(bytes) && !target.startsWith(".."),
        `External source link: ${file}`,
      );
    }
    hash.update(`${file}\0${mode}\0`);
    hash.update(createHash("sha256").update(bytes).digest());
    present.push(file);
  }
  return { files: present, sourceId: hash.digest("hex") };
}

// Both builds must finish before either live daemon is touched. Local goes last
// because stopping it can terminate the agent that launched this command.
export async function deployBoth({ local, code, prepareOnly }) {
  const results = await Promise.allSettled([local.prepare(), code.prepare()]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Preparation failed; neither daemon was switched",
    );
  if (prepareOnly) return;
  await activateBoth({ local, code });
}

export async function activateBoth({ local, code }) {
  await code.activate();
  try {
    await local.activate();
  } catch (error) {
    throw new Error(
      "code was updated, but local activation failed. Inspect local recovery output; the two hosts may now run different builds.",
      { cause: error },
    );
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { host: { type: "string", default: "code" }, help: { type: "boolean" } },
  });
  if (values.help) {
    process.stdout.write(`Usage: npm run deploy:all -- [deploy|prepare|activate] [--host code]
  deploy    Synchronize source, prepare both hosts, activate code then this machine (default)
  prepare   Build and verify both hosts without stopping live daemons
  activate  Activate the exact pair saved by the last successful preparation
Remote source/runtime: ~/.local/share/paseo-personal/{source,runtime}
Both daemon homes: ~/.paseo. Run deploy/activate from an independent terminal.
`);
    return;
  }
  const [action = "deploy"] = positionals;
  assert.ok(positionals.length <= 1 && ["deploy", "prepare", "activate"].includes(action));
  const host = values.host;
  assert.match(host, /^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/, "Use an SSH host alias");
  await mkdir(root, { recursive: true });
  const lock = path.join(root, ".targets-lock");
  await mkdir(lock);
  let remoteRoot;
  let remoteLocked = false;
  const planFile = path.join(root, "targets-prepared.json");
  try {
    remoteRoot = JSON.parse(
      await remoteNode(
        host,
        `
import {homedir} from 'node:os';
import path from 'node:path';
process.stdout.write(JSON.stringify(path.join(homedir(), '.local/share/paseo-personal')));
`,
        true,
      ),
    );
    const remoteSource = path.posix.join(remoteRoot, "source");
    const remoteRuntime = path.posix.join(remoteRoot, "runtime");
    await remoteNode(
      host,
      `
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
const root = ${JSON.stringify(remoteRoot)};
await mkdir(root, {recursive:true});
try { if ((await readFile(root+'/managed-by','utf8')) !== 'paseo-deploy-all') throw Error('Unrecognized deployment directory'); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if ((await readdir(root)).length) throw Error('Refusing to reuse a nonempty unmanaged directory');
  await writeFile(root+'/managed-by','paseo-deploy-all');
}
await mkdir(root+'/.targets-lock');
await mkdir(root+'/source', {recursive:true});
`,
    );
    remoteLocked = true;
    let plan;
    if (action === "activate") {
      plan = JSON.parse(await readFile(planFile, "utf8"));
      assert.equal(plan.host, host, "Prepared target differs; prepare both hosts again");
      assert.equal(plan.remoteRoot, remoteRoot);
    }
    const targets = {
      local: {
        prepare: async () => {
          await run(process.execPath, [
            "scripts/deploy-personal.mjs",
            "prepare",
            "--source-info",
            path.join(root, "targets-source.json"),
          ]);
          const after = await sourceSnapshot(repo);
          assert.equal(
            after.sourceId,
            plan.sourceId,
            "Source changed during preparation; run prepare again",
          );
          plan.local = JSON.parse(await readFile(path.join(root, "prepared.json"), "utf8"));
        },
        activate: async () => {
          const npmRoot = (await run("npm", ["root", "-g"], { capture: true })).trim();
          const args = [
            "scripts/deploy-personal.mjs",
            "activate",
            "--release",
            plan.local.release,
            "--home",
            path.join(homedir(), ".paseo"),
          ];
          const previous = path.join(npmRoot, "@lalaze/paseo-cli/dist/index.js");
          try {
            await lstat(previous);
            args.push("--previous-cli", previous);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await run(process.execPath, args);
        },
      },
      code: {
        prepare: async () => {
          const list = path.join(root, "targets-files");
          const snapshot = JSON.parse(
            await readFile(path.join(root, "targets-source.json"), "utf8"),
          );
          await writeFile(list, `${snapshot.files.join("\0")}\0`);
          await run("rsync", [
            "-a",
            "--checksum",
            "--from0",
            `--files-from=${list}`,
            "-e",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
            `${repo}/`,
            `${host}:${shellQuote(`${remoteSource}/`)}`,
          ]);
          await run("rsync", [
            "-a",
            "-e",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
            path.join(root, "targets-source.json"),
            `${host}:${shellQuote(`${remoteRoot}/incoming-source.json`)}`,
          ]);
          await remoteNode(
            host,
            `
import {readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {sourceSnapshot} from ${JSON.stringify(`file://${remoteSource}/scripts/deploy-personal-targets.mjs`)};
const root = ${JSON.stringify(remoteRoot)};
const next = JSON.parse(await readFile(root+'/incoming-source.json','utf8'));
let previous = {files:[]};
try { previous = JSON.parse(await readFile(root+'/source-info.json','utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const retained = new Set(next.files);
for (const file of previous.files) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) throw Error('Invalid previous source path');
  if (!retained.has(file)) await rm(path.join(root,'source',file), {force:true});
}
const actual = await sourceSnapshot(root+'/source', next.files);
if (actual.sourceId !== next.sourceId) throw Error('Transferred source does not match the local snapshot');
await writeFile(root+'/source-info.json',JSON.stringify(next));
`,
          );
          await remote(
            host,
            `cd ${shellQuote(remoteSource)}
export NODE_OPTIONS="--max-old-space-size=4096"
git init -q
dependency_key=$(node --input-type=module <<'PASEO_DEPLOY_NODE'
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source = JSON.parse(await readFile(${JSON.stringify(`${remoteRoot}/source-info.json`)},'utf8'));
const files = source.files.filter(file => file === 'package-lock.json' || file === 'package.json' || file === '.npmrc' || (file.startsWith('packages/') && file.endsWith('/package.json') && file.split('/').length === 3) || file.startsWith('patches/') || file === 'scripts/postinstall-patches.mjs');
const hash = createHash('sha256').update(process.version);
for (const file of files) { hash.update(file); hash.update(await readFile(file)); }
process.stdout.write(hash.digest('hex'));
PASEO_DEPLOY_NODE
)
if [ ! -d node_modules ] || [ "$(cat ${shellQuote(`${remoteRoot}/dependencies-key`)} 2>/dev/null || true)" != "$dependency_key" ]; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip LEFTHOOK=0 npm ci --no-audit --no-fund
  printf '%s' "$dependency_key" > ${shellQuote(`${remoteRoot}/dependencies-key`)}
fi
node scripts/deploy-personal.mjs prepare --root ${shellQuote(remoteRuntime)} --source-info ${shellQuote(`${remoteRoot}/source-info.json`)}
`,
          );
          plan.code = JSON.parse(
            await remoteNode(
              host,
              `import {readFile} from 'node:fs/promises'; process.stdout.write(await readFile(${JSON.stringify(`${remoteRuntime}/prepared.json`)},'utf8'));`,
              true,
            ),
          );
        },
        activate: () =>
          remote(
            host,
            `cd ${shellQuote(remoteSource)}
args=(activate --root ${shellQuote(remoteRuntime)} --release ${shellQuote(plan.code.release)} --home "$HOME/.paseo")
previous="$(npm root -g)/@lalaze/paseo-cli/dist/index.js"
if [ -f "$previous" ]; then args+=(--previous-cli "$previous"); fi
node scripts/deploy-personal.mjs "\${args[@]}"
`,
          ),
      },
    };
    if (action !== "activate") {
      const snapshot = await sourceSnapshot(repo);
      snapshot.commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
      snapshot.dirty = Boolean(
        (await run("git", ["status", "--porcelain"], { capture: true })).trim(),
      );
      await writeFile(path.join(root, "targets-source.json"), JSON.stringify(snapshot));
      plan = { host, remoteRoot, sourceId: snapshot.sourceId };
      await deployBoth({ ...targets, prepareOnly: true });
      assert.equal(plan.local.sourceId, snapshot.sourceId);
      assert.equal(plan.code.sourceId, snapshot.sourceId);
      await writeFile(planFile, JSON.stringify(plan, null, 2));
      process.stdout.write(
        `Both runtimes verified from source ${snapshot.sourceId.slice(0, 12)}.\n`,
      );
    }
    if (action !== "prepare") {
      assert.ok(
        plan.local.quotaPatchSnapshot,
        "Local runtime lacks quota patches; prepare both hosts again",
      );
      assert.equal(
        plan.local.quotaPatchSnapshot,
        await quotaPatchSnapshot(),
        "Quota bundle changed; prepare both hosts again",
      );
      assert.equal(
        plan.local.quotaPatchSnapshot,
        plan.code.quotaPatchSnapshot,
        "Quota patches differ; prepare both hosts again",
      );
      await activateBoth(targets);
      process.stdout.write(`Deployment complete: ${host} and local.\n`);
    } else {
      process.stdout.write("Ready: npm run deploy:all -- activate\n");
    }
  } finally {
    try {
      if (remoteLocked) await remote(host, `rmdir ${shellQuote(`${remoteRoot}/.targets-lock`)}`);
    } finally {
      await rm(lock, { recursive: true });
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    if (error instanceof AggregateError)
      for (const reason of error.errors) process.stderr.write(`${reason.stack ?? reason}\n`);
    process.exitCode = 1;
  });
}
