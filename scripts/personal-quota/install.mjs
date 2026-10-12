import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const bundle = import.meta.dirname;
const builtinBase = "packages/server/dist/server/builtin-plugins";
const registryFile = "packages/server/dist/server/server/plugins/builtin/index.js";
const kimiFile = `${builtinBase}/kimi-usage-source/server/usage.ts`;
const payloads = ["kimi-refresh.js"];
const receiptFile = "quota-patches.json";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceOnce(text, anchor, replacement) {
  assert.equal(text.split(anchor).length, 2, "Quota patch requires exactly one upstream anchor");
  return text.replace(anchor, replacement);
}

export function patchQuotaModules({ registry, kimi }) {
  assert.doesNotMatch(
    registry,
    /antigravity-usage-source/,
    "Retired Antigravity quota extension must not be loaded",
  );
  assert.doesNotMatch(kimi, /ensureKimiCredentialsFresh/, "Kimi is already patched");
  return {
    registry: replaceOnce(registry, '    "copilot-usage-source",\n', ""),
    kimi:
      'import { ensureKimiCredentialsFresh } from "./kimi-refresh.js";\n' +
      replaceOnce(
        kimi,
        "  const credentials = await readCredentials(input);",
        `  let credentials = await readCredentials(input);
  if (credentials && input.store === "file") {
    await ensureKimiCredentialsFresh(input.locator, credentials);
    credentials = await readCredentials(input);
  }`,
      ),
  };
}

export async function quotaPatchSnapshot() {
  const hash = createHash("sha256");
  for (const file of [
    "install.mjs",
    "compatibility.json",
    ...payloads.map((f) => `providers/${f}`),
  ]) {
    hash.update(await readFile(path.join(bundle, file)));
  }
  return hash.digest("hex");
}

function runtimeRelative(release, file) {
  const relative = path.relative(release, file);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `External quota dependency: ${file}`,
  );
  return relative;
}

// Called only on an unpublished runtime. A failure leaves the active daemon untouched.
export async function installQuotaPatches(release) {
  const baseline = JSON.parse(await readFile(path.join(bundle, "compatibility.json"), "utf8"));
  const files = [];
  for (const [file, expected] of Object.entries(baseline.serverFiles)) {
    const relative = `packages/server/${file}`;
    assert.equal(
      sha(await readFile(path.join(release, relative))),
      expected,
      `Quota compatibility changed: ${relative}`,
    );
    files.push(relative);
  }
  const kimi = await readFile(path.join(release, kimiFile), "utf8");
  const registry = await readFile(path.join(release, registryFile), "utf8");
  const require = createRequire(path.join(release, "packages/server/package.json"));
  const usageSdkFile = runtimeRelative(release, require.resolve("@getpaseo/plugin/server/usage"));
  assert.equal(
    sha(await readFile(path.join(release, usageSdkFile))),
    baseline.usageSdkSha256,
    "Usage SDK compatibility changed",
  );
  files.push(usageSdkFile);
  const protocolFile = runtimeRelative(release, require.resolve("@getpaseo/protocol/messages"));
  const protocol = await readFile(path.join(release, protocolFile), "utf8");
  const start = protocol.indexOf("export const ProviderUsageToneSchema");
  const end = protocol.indexOf("const AgentSlashCommandSchema", start);
  assert.ok(start >= 0 && end > start, "ProviderUsage schema boundary changed");
  assert.equal(
    sha(protocol.slice(start, end)),
    baseline.protocolUsageSha256,
    "ProviderUsage schema changed",
  );
  const ptyFile = runtimeRelative(release, require.resolve("node-pty/package.json"));
  const pty = JSON.parse(await readFile(path.join(release, ptyFile), "utf8"));
  assert.equal(pty.version, baseline.nodePtyVersion, "node-pty compatibility changed");
  const patched = patchQuotaModules({ registry, kimi });
  const contents = {
    [`${builtinBase}/kimi-usage-source/server/kimi-refresh.js`]: await readFile(
      path.join(bundle, "providers/kimi-refresh.js"),
    ),
  };
  for (const [file, content] of Object.entries(contents)) {
    await writeFile(path.join(release, file), content, { flag: "wx" });
    files.push(file);
  }
  await writeFile(path.join(release, kimiFile), patched.kimi);
  await writeFile(path.join(release, registryFile), patched.registry);
  files.push(protocolFile, ptyFile);
  const hashes = {};
  for (const file of files) hashes[file] = sha(await readFile(path.join(release, file)));
  const receipt = {
    source: baseline.source,
    snapshotId: await quotaPatchSnapshot(),
    files: hashes,
  };
  await writeFile(path.join(release, receiptFile), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export async function verifyQuotaPatches(release) {
  const receipt = JSON.parse(await readFile(path.join(release, receiptFile), "utf8"));
  assert.equal(
    receipt.snapshotId,
    await quotaPatchSnapshot(),
    "Quota patch bundle changed; prepare a new runtime",
  );
  const required = [
    registryFile,
    kimiFile,
    `${builtinBase}/kimi-usage-source/server/kimi-refresh.js`,
  ];
  for (const file of required)
    assert.equal(typeof receipt.files[file], "string", `Missing quota patch: ${file}`);
  assert.doesNotMatch(
    await readFile(path.join(release, registryFile), "utf8"),
    /antigravity-usage-source/,
    "Retired Antigravity quota extension must not be loaded",
  );
  assert.doesNotMatch(
    await readFile(path.join(release, registryFile), "utf8"),
    /copilot-usage-source/,
    "Personal runtime must not query GitHub Copilot usage",
  );
  for (const [file, expected] of Object.entries(receipt.files)) {
    const relative = runtimeRelative(release, path.resolve(release, file));
    assert.equal(
      sha(await readFile(path.join(release, relative))),
      expected,
      `Quota runtime changed: ${file}`,
    );
  }
}
