import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = path.resolve(process.argv[2]);
const release = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8"));
const root = await mkdtemp(path.join(tmpdir(), "paseo-fork-install-"));
const prefix = path.join(root, "install");
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const registry = createServer(async (request, response) => {
  const name = decodeURIComponent(request.url.slice(1));
  const pkg = release.packages.find((entry) => entry.name === name || entry.tarball === name);
  if (!pkg) {
    response.writeHead(404).end();
    return;
  }
  if (name === pkg.tarball) {
    response.setHeader("content-type", "application/octet-stream");
    response.end(await readFile(path.join(directory, pkg.tarball)));
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      name: pkg.name,
      "dist-tags": { beta: pkg.version, latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg.manifest,
          dist: { tarball: `${origin}/${pkg.tarball}`, integrity: pkg.integrity },
        },
      },
    }),
  );
});
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${registry.address().port}`;
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: root,
      env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}`));
        return;
      }
      resolve();
    });
  });
}
const cli = release.packages.find((pkg) => pkg.name === `${release.scope}/paseo-cli`);
const installedCli = path.join(prefix, "lib", "node_modules", cli.name, "dist", "index.js");
let launched = false;
try {
  for (const pkg of release.packages) {
    const bytes = await readFile(path.join(directory, pkg.tarball));
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, pkg.integrity);
  }
  await run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    path.join(directory, cli.tarball),
    `${release.scope}:registry=${origin}`.replace(/^/, "--"),
    "--no-audit",
    "--no-fund",
  ]);
  await run(process.execPath, [installedCli, "--version"]);
  const require = createRequire(installedCli);
  const realPrefix = await realpath(prefix);
  for (const pkg of release.packages) {
    const name = pkg.manifest.paseoDistribution.sourcePackage;
    if (name === "@getpaseo/cli") continue;
    const resolved = require.resolve(
      `${name === "@getpaseo/protocol" ? `${name}/messages` : name}`,
    );
    assert.ok(
      resolved.startsWith(`${realPrefix}${path.sep}`),
      `${name} escaped the isolated install`,
    );
  }
  await mkdir(home);
  await mkdir(workspace);
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
      features: { webUi: { enabled: true } },
    }),
  );
  launched = true;
  await run(process.execPath, [installedCli, "daemon", "start", "--home", home, "--timeout", "60"]);
  const { connectToDaemon } = await import(
    pathToFileURL(path.join(path.dirname(installedCli), "utils", "client.js"))
  );
  const client = await connectToDaemon({ target: { kind: "instance", home }, timeout: 10000 });
  try {
    const info = client.getLastServerInfoMessage();
    assert.equal(info.version, release.version);
    assert.equal(info.features.workspaceFileUpload, true);
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const upload = await client.uploadFile({
      fileName: "smoke.bin",
      mimeType: "application/octet-stream",
      bytes,
      destination: { cwd: workspace, directory: "." },
    });
    assert.equal(upload.error, null);
    assert.deepEqual(await readFile(path.join(workspace, "smoke.bin")), Buffer.from(bytes));
    const lock = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
    const response = await fetch(`http://${lock.listen}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/);
    const plugin = await import(pathToFileURL(require.resolve("@getpaseo/plugin")));
    assert.equal(typeof plugin.defineRpc, "function");
    const serverRoot = path.resolve(path.dirname(require.resolve("@getpaseo/server")), "../../..");
    const updater = await import(
      pathToFileURL(path.join(serverRoot, "dist/server/server/session/daemon/npm-global-cli.js"))
    );
    assert.equal(updater.PASEO_CLI_PACKAGE, cli.name);
    process.stdout.write(
      `Verified ${cli.name}@${release.version}: isolated global install, daemon startup, upload bytes, web UI, SDK imports, update identity.\n`,
    );
  } finally {
    await client.close();
  }
  await writeFile(
    path.join(directory, "verified.json"),
    JSON.stringify(
      {
        version: release.version,
        root,
        packages: release.packages.map(({ name, integrity }) => ({ name, integrity })),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (launched) await run(process.execPath, [installedCli, "daemon", "stop", "--home", home]);
  } finally {
    registry.closeAllConnections();
    await new Promise((resolve) => registry.close(resolve));
  }
}
