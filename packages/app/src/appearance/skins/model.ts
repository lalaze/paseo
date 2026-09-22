import { z } from "zod";

export class SkinImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkinImportError";
  }
}

// Dream Skin accepts these color forms. Keep imported values out of CSS source text.
export const skinColorSchema = z
  .string()
  .max(64)
  .regex(
    /^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i,
  );
export const skinPaletteSchema = z.object({
  background: skinColorSchema,
  panel: skinColorSchema,
  panelAlt: skinColorSchema,
  accent: skinColorSchema,
  accentAlt: skinColorSchema.optional(),
  secondary: skinColorSchema.optional(),
  highlight: skinColorSchema.optional(),
  text: skinColorSchema,
  muted: skinColorSchema,
  line: skinColorSchema,
});
export type SkinPalette = z.infer<typeof skinPaletteSchema>;

export const skinMetadataSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(80),
  appearance: z.enum(["light", "dark"]),
  colors: skinPaletteSchema.nullable(),
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  strength: z.number().min(0).max(1),
  author: z.string().max(160),
  license: z.string().max(65536),
  provenance: z.string().max(1000),
  thumbnail: z.string(),
});
export type SkinMetadata = z.infer<typeof skinMetadataSchema>;
export interface ImportedSkin extends SkinMetadata {
  image: Blob;
}
export interface SkinLibrary {
  skins: SkinMetadata[];
  active: ImportedSkin | null;
  strength: number;
}
export const EMPTY_SKIN_LIBRARY: SkinLibrary = { skins: [], active: null, strength: 0.3 };
export const SKIN_LIBRARY_KEY = ["image-skins"];
