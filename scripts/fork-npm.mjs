import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

export const forkPackages = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const registry = "https://registry.npmjs.org/";

export function forkPackageName(scope, name) {
  if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope) || scope === "@getpaseo") {
    throw new Error("Use your own npm scope, for example @lalaze.");
  }
  if (!forkPackages.includes(name)) throw new Error(`Unknown runtime package: ${name}`);
  return `${scope}/paseo-${name}`;
}

export function forkManifest(manifest, { scope, version }) {
  if (!semver.valid(version)) throw new Error(`Invalid version: ${version}`);
  const shortName = manifest.name.replace(/^@getpaseo\//, "");
  const rewritten = {
    ...manifest,
    name: forkPackageName(scope, shortName),
    version,
    license: "Apache-2.0",
    repository: { type: "git", url: "git+https://github.com/lalaze/paseo.git" },
    publishConfig: { access: "public", registry },
    paseoDistribution: { sourcePackage: manifest.name, sourceVersion: manifest.version },
  };
  delete rewritten.scripts;
  delete rewritten.devDependencies;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!manifest[field]) continue;
    rewritten[field] = { ...manifest[field] };
    for (const name of forkPackages) {
      const originalName = `@getpaseo/${name}`;
      if (!(originalName in rewritten[field])) continue;
      const alias = `npm:${forkPackageName(scope, name)}@${version}`;
      if (field === "peerDependencies") {
        // These exact SDK dependencies must come from the fork even when installed alone.
        delete rewritten[field][originalName];
        rewritten.dependencies = { ...rewritten.dependencies, [originalName]: alias };
      } else {
        rewritten[field][originalName] = alias;
      }
    }
  }
  return rewritten;
}

export function replaceArtifactIdentity(source, from, to) {
  if (source.split(from).length !== 2) {
    throw new Error(`Expected exactly one package identity site: ${from}`);
  }
  return source.replace(from, to);
}

async function patchRuntimeIdentity(directory, name, scope) {
  // Preserve canonical imports and the plugin SDK ABI. Only install identity changes.
  const serverName = forkPackageName(scope, "server");
  const cliName = forkPackageName(scope, "cli");
  const patches = {
    cli: [
      [
        "dist/commands/daemon/local-daemon.js",
        'packageJson.name !== "@getpaseo/server"',
        `packageJson.name !== "${serverName}"`,
      ],
    ],
    server: [
      [
        "dist/server/server/daemon-version.js",
        'SERVER_PACKAGE_NAME = "@getpaseo/server"',
        `SERVER_PACKAGE_NAME = "${serverName}"`,
      ],
      [
        "dist/server/server/session/daemon/install-origin.js",
        'resolvePackageRootFrom(fileURLToPath(import.meta.url), "@getpaseo/server")',
        `resolvePackageRootFrom(fileURLToPath(import.meta.url), "${serverName}")`,
      ],
      [
        "dist/server/server/session/daemon/npm-global-cli.js",
        'PASEO_CLI_PACKAGE = "@getpaseo/cli"',
        `PASEO_CLI_PACKAGE = "${cliName}"`,
      ],
    ],
  };
  for (const [relativePath, from, to] of patches[name] ?? []) {
    const file = path.join(directory, relativePath);
    await writeFile(file, replaceArtifactIdentity(await readFile(file, "utf8"), from, to));
  }
}

function npmPack(directory, destination) {
  const output = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const [packed] = JSON.parse(output);
  return packed.filename;
}

export async function prepareForkPackages({ root, output, scope, version }) {
  forkPackageName(scope, "cli");
  if (!semver.valid(version)) throw new Error(`Invalid version: ${version}`);
  await mkdir(output, { recursive: false });
  const originals = path.join(output, "originals");
  await mkdir(originals);
  const packages = [];
  for (const name of forkPackages) {
    const filename = npmPack(path.join(root, "packages", name), originals);
    const staging = path.join(output, "staging", name);
    await mkdir(staging, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(originals, filename), "-C", staging]);
    const directory = path.join(staging, "package");
    const manifest = forkManifest(
      JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")),
      { scope, version },
    );
    await patchRuntimeIdentity(directory, name, scope);
    await writeFile(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(directory, "LICENSE"), await readFile(path.join(root, "LICENSE")));
    const tarball = npmPack(directory, output);
    const bytes = await readFile(path.join(output, tarball));
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    packages.push({ name: manifest.name, version, tarball, integrity, manifest });
    process.stdout.write(`${manifest.name}@${version}: ${tarball}\n`);
  }
  const release = { scope, version, packages };
  await writeFile(path.join(output, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [scope, version, destination] = process.argv.slice(2);
  if (!scope || !version || !destination)
    throw new Error("Usage: node scripts/fork-npm.mjs @scope version output-directory");
  await prepareForkPackages({
    root: path.resolve(import.meta.dirname, ".."),
    output: path.resolve(destination),
    scope,
    version,
  });
}
