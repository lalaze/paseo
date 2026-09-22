import { Unzip, UnzipInflate } from "fflate";
import { z } from "zod";
import { SkinImportError, skinPaletteSchema, type ImportedSkin } from "./model";
import { opaqueSkinColor, skinAppearance } from "./color";

export const MAX_SKIN_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const fileName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^/\\]+$/)
  .refine((name) => [...name].every((char) => char.charCodeAt(0) >= 32))
  .refine((name) => name !== "." && name !== "..");
const themeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  image: fileName,
  appearance: z.enum(["auto", "light", "dark"]).default("auto"),
  art: z
    .object({
      focusX: z.number().min(0).max(1).default(0.5),
      focusY: z.number().min(0).max(1).default(0.5),
      taskMode: z.enum(["ambient", "full", "off"]).default("ambient"),
    })
    .prefault({}),
  colors: skinPaletteSchema.optional(),
});
const manifestSchema = z.object({
  packageVersion: z.literal(1),
  skinApiVersion: z.literal(1),
  themeId: z.string(),
  publisher: z.object({ displayName: z.string().max(160) }),
  license: z.string().max(128),
  provenance: z.object({ summary: z.string().max(1000) }),
  files: z
    .array(
      z.object({
        path: fileName,
        bytes: z.number().int().positive().max(MAX_SKIN_ARCHIVE_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
    )
    .min(2)
    .max(8),
});

export async function skinDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

function entryLimit(name: string): number {
  if (/\.(png|jpe?g|webp)$/i.test(name)) return MAX_IMAGE_BYTES;
  if (name === "theme.json") return 1024 * 1024;
  if (name === "theme.css") return 256 * 1024;
  if (["manifest.json", "manifest.sig", "LICENSE.txt"].includes(name)) return 65536;
  throw new SkinImportError(`Unsupported theme file: ${name}`);
}

function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > MAX_SKIN_ARCHIVE_BYTES) throw new SkinImportError("Theme ZIP exceeds 32 MB.");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new SkinImportError("Select a Dream Skin ZIP file.");
  const entries = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let root: string | null = null;
  let count = 0;
  let total = 0;
  const unzip = new Unzip((file) => {
    count += 1;
    if (count > 32) throw new SkinImportError("Theme ZIP contains too many entries.");
    const parts = file.name.replace(/\/$/, "").split("/");
    if (parts.length > 2 || parts.some((part) => !fileName.safeParse(part).success)) {
      throw new SkinImportError("Theme ZIP contains an invalid path.");
    }
    if (file.name.endsWith("/")) return;
    const directory = parts.length === 2 ? parts[0] : "";
    if (root !== null && root !== directory)
      throw new SkinImportError("Keep the theme files in one folder.");
    root = directory;
    const name = parts[parts.length - 1];
    if (names.has(name)) throw new SkinImportError(`Duplicate theme file: ${name}`);
    names.add(name);
    const limit = entryLimit(name);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      total += chunk.length;
      if (size > limit || total > 16 * 1024 * 1024) {
        file.terminate();
        throw new SkinImportError("Expanded theme files exceed the size limit.");
      }
      chunks.push(chunk);
      if (!final) return;
      const content = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        content.set(part, offset);
        offset += part.length;
      }
      entries.set(name, content);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small pushes also bound each decompressor callback, including dishonest ZIP sizes.
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  }
  if (entries.size !== names.size) throw new SkinImportError("The theme ZIP is incomplete.");
  return entries;
}

function imageMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && decoder.decode(bytes.subarray(1, 4)) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  throw new SkinImportError("The background must be a PNG, JPEG or WebP image.");
}

export async function readSkinPackage(bytes: Uint8Array): Promise<ImportedSkin> {
  const entries = readArchive(bytes);
  const themeBytes = entries.get("theme.json");
  if (!themeBytes)
    throw new SkinImportError("The ZIP must contain theme.json and its background image.");
  const theme = themeSchema.parse(readJson(themeBytes));
  const imageBytes = entries.get(theme.image);
  const images = [...entries.keys()].filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
  if (!imageBytes || images.length !== 1)
    throw new SkinImportError("The theme must contain exactly one background image.");
  let author = "";
  let license = "";
  let provenance = "";
  const manifestBytes = entries.get("manifest.json");
  if (manifestBytes) {
    const manifest = manifestSchema.parse(readJson(manifestBytes));
    if (manifest.themeId !== theme.id)
      throw new SkinImportError("Theme and manifest IDs do not match.");
    const verified = new Set<string>();
    for (const file of manifest.files) {
      const content = entries.get(file.path);
      if (!content || verified.has(file.path))
        throw new SkinImportError(`Invalid manifest entry: ${file.path}`);
      if (
        content.length !== file.bytes ||
        (await skinDigest(content)) !== file.sha256.toLowerCase()
      ) {
        throw new SkinImportError(`Theme integrity check failed: ${file.path}`);
      }
      verified.add(file.path);
    }
    if (!verified.has("theme.json") || !verified.has(theme.image))
      throw new SkinImportError("Manifest does not cover the theme and image.");
    author = manifest.publisher.displayName;
    license = manifest.license;
    provenance = manifest.provenance.summary;
  }
  const licenseBytes = entries.get("LICENSE.txt");
  if (licenseBytes) license = `${license}\n${decoder.decode(licenseBytes)}`.trim();
  // This adapter imports artwork and declared tokens. Codex-specific CSS and scripts
  // are never evaluated, and a manifest hash is not treated as an author signature.
  const inferredAppearance = skinAppearance(theme.colors?.background ?? "#181b1a");
  const appearance = theme.appearance === "auto" ? inferredAppearance : theme.appearance;
  // Paseo tokens are also used in opaque popovers and hexadecimal alpha suffixes.
  // Composite translucent Dream Skin tokens against their base before adapting them.
  const colors = theme.colors
    ? skinPaletteSchema.parse(
        Object.fromEntries(
          Object.entries(theme.colors).map(([key, value]) => [
            key,
            opaqueSkinColor(value, key === "background" ? undefined : theme.colors?.background),
          ]),
        ),
      )
    : null;
  let strength = 0.3;
  if (theme.art.taskMode === "full") strength = 0.65;
  if (theme.art.taskMode === "off") strength = 0;
  return {
    id: await skinDigest(bytes),
    name: theme.name,
    appearance,
    colors,
    focusX: theme.art.focusX,
    focusY: theme.art.focusY,
    strength,
    author,
    license,
    provenance,
    thumbnail: "",
    image: new Blob([Uint8Array.from(imageBytes)], { type: imageMediaType(imageBytes) }),
  };
}
