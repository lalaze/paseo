import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2]);
const release = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8"));
const verified = JSON.parse(await readFile(path.join(directory, "verified.json"), "utf8"));
const registry = "https://registry.npmjs.org/";
assert.equal(release.scope, "@lalaze");
assert.equal(verified.version, release.version);
const account = execFileSync("npm", ["whoami", `--registry=${registry}`], {
  encoding: "utf8",
}).trim();
assert.equal(`@${account}`, release.scope);
for (const pkg of release.packages) {
  assert.ok(pkg.name.startsWith(`${release.scope}/paseo-`));
  const bytes = await readFile(path.join(directory, pkg.tarball));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, pkg.integrity);
  assert.ok(
    verified.packages.some((entry) => entry.name === pkg.name && entry.integrity === integrity),
  );
}
const tag = release.version.includes("-") ? "beta" : "latest";
for (const pkg of release.packages) {
  // Permit resuming a partially completed publish only when the registry has the exact artifact.
  const response = await fetch(`${registry}${encodeURIComponent(pkg.name)}/${pkg.version}`);
  if (response.ok) {
    const published = await response.json();
    assert.equal(
      published.dist.integrity,
      pkg.integrity,
      `${pkg.name} was published with different bytes`,
    );
    process.stdout.write(`Already published: ${pkg.name}@${pkg.version}\n`);
    continue;
  }
  assert.equal(response.status, 404, `Unable to inspect ${pkg.name}: HTTP ${response.status}`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "publish",
        path.join(directory, pkg.tarball),
        "--access",
        "public",
        "--tag",
        tag,
        "--ignore-scripts",
        `--registry=${registry}`,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Publishing ${pkg.name} exited ${code}`));
        return;
      }
      resolve();
    });
  });
}
process.stdout.write(`Install with npm install -g ${release.scope}/paseo-cli@${release.version}\n`);
