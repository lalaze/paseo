import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const bundle = import.meta.dirname;
const base = "packages/server/dist/server/services/quota-fetcher";
export const quotaCompatibilityFiles = [`${base}/provider.d.ts`];
const payloads = ["antigravity.js", "antigravity-local.js", "kimi-refresh.js"];
const receiptFile = "quota-patches.json";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceOnce(text, anchor, replacement) {
  assert.equal(text.split(anchor).length, 2, "Quota patch requires exactly one upstream anchor");
  return text.replace(anchor, replacement);
}

export function patchQuotaModules({ manifest, kimi }) {
  assert.doesNotMatch(manifest, /antigravity/i, "Review existing Antigravity support");
  assert.doesNotMatch(kimi, /ensureKimiCredentialsFresh/, "Kimi is already patched");
  return {
    manifest:
      'import { AntigravityQuotaProvider } from "./providers/antigravity.js";\n' +
      replaceOnce(
        manifest,
        "export const PROVIDER_USAGE_FETCHERS = [",
        'export const PROVIDER_USAGE_FETCHERS = [\n    { providerId: "antigravity-acp", create: (options) => new AntigravityQuotaProvider({ logger: options.logger }) },',
      ),
    kimi:
      'import { ensureKimiCredentialsFresh } from "./kimi-refresh.js";\n' +
      replaceOnce(
        kimi,
        "                return { ...credentials, access_token: credentials.access_token };",
        "                await ensureKimiCredentialsFresh(path, credentials);\n" +
          "                const refreshed = await this.readCredentialFile(path);\n" +
          "                if (!refreshed?.access_token) return null;\n" +
          "                return { ...refreshed, access_token: refreshed.access_token };",
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
  const kimiFile = `${base}/providers/kimi.js`;
  const kimi = await readFile(path.join(release, kimiFile), "utf8");
  assert.equal(sha(kimi), baseline.kimiFileSha256, "Kimi quota compatibility changed");
  const require = createRequire(path.join(release, "packages/server/package.json"));
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
  const manifestFile = `${base}/manifest.js`;
  const manifest = await readFile(path.join(release, manifestFile), "utf8");
  const patched = patchQuotaModules({ manifest, kimi });
  for (const file of payloads) {
    const relative = `${base}/providers/${file}`;
    await writeFile(
      path.join(release, relative),
      await readFile(path.join(bundle, "providers", file)),
      { flag: "wx" },
    );
    files.push(relative);
  }
  await writeFile(path.join(release, kimiFile), patched.kimi);
  await writeFile(path.join(release, manifestFile), patched.manifest);
  files.push(kimiFile, protocolFile, ptyFile);
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
    `${base}/manifest.js`,
    `${base}/providers/kimi.js`,
    ...payloads.map((f) => `${base}/providers/${f}`),
  ];
  for (const file of required)
    assert.equal(typeof receipt.files[file], "string", `Missing quota patch: ${file}`);
  for (const [file, expected] of Object.entries(receipt.files)) {
    const relative = runtimeRelative(release, path.resolve(release, file));
    assert.equal(
      sha(await readFile(path.join(release, relative))),
      expected,
      `Quota runtime changed: ${file}`,
    );
  }
}
