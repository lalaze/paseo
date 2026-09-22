import { z } from "zod";
import { skinMetadataSchema, SkinImportError, type ImportedSkin, type SkinLibrary } from "./model";

const selectionSchema = z.object({ id: z.string().nullable(), strength: z.number().min(0).max(1) });

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("paseo-image-skins", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("metadata", { keyPath: "id" });
      request.result.createObjectStore("images");
      request.result.createObjectStore("preferences");
    };
    request.onsuccess = () => resolve(request.result);
    request.addEventListener("error", () => reject(request.error));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

export async function readSkinLibrary(): Promise<SkinLibrary> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["metadata", "images", "preferences"], "readonly");
    const done = complete(transaction);
    const metadata = transaction.objectStore("metadata").getAll();
    const selection = transaction.objectStore("preferences").get("selection");
    const reads: { image: IDBRequest<unknown> | null } = { image: null };
    selection.onsuccess = () => {
      const parsed = selectionSchema.safeParse(selection.result);
      if (parsed.success && parsed.data.id)
        reads.image = transaction.objectStore("images").get(parsed.data.id);
    };
    await done;
    const skins = z.array(skinMetadataSchema).parse(metadata.result);
    const parsed = selectionSchema.safeParse(selection.result);
    const preference = parsed.success ? parsed.data : { id: null, strength: 0.3 };
    const selected = skins.find((skin) => skin.id === preference.id);
    const image: unknown = reads.image?.result;
    const active = selected && image instanceof Blob ? { ...selected, image } : null;
    return { skins, active, strength: preference.strength };
  } finally {
    database.close();
  }
}

export async function saveSkin(skin: ImportedSkin): Promise<void> {
  const { image, ...metadata } = skin;
  const validMetadata = skinMetadataSchema.parse(metadata);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["metadata", "images", "preferences"], "readwrite");
    const done = complete(transaction);
    transaction.objectStore("metadata").put(validMetadata);
    transaction.objectStore("images").put(image, skin.id);
    transaction
      .objectStore("preferences")
      .put({ id: skin.id, strength: skin.strength }, "selection");
    await done;
  } finally {
    database.close();
  }
}

export async function selectSkin(id: string | null, strength: number): Promise<void> {
  const preference = selectionSchema.parse({ id, strength });
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["preferences", "metadata"], "readwrite");
    const done = complete(transaction);
    transaction.objectStore("preferences").put(preference, "selection");
    if (id) {
      const metadata = transaction.objectStore("metadata").get(id);
      metadata.onsuccess = () => {
        const parsed = skinMetadataSchema.safeParse(metadata.result);
        if (parsed.success) transaction.objectStore("metadata").put({ ...parsed.data, strength });
      };
    }
    await done;
  } finally {
    database.close();
  }
}

export async function removeSkin(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["metadata", "images", "preferences"], "readwrite");
    const done = complete(transaction);
    const selection = transaction.objectStore("preferences").get("selection");
    selection.onsuccess = () => {
      const parsed = selectionSchema.safeParse(selection.result);
      if (parsed.success && parsed.data.id === id)
        transaction.objectStore("preferences").delete("selection");
    };
    transaction.objectStore("metadata").delete(id);
    transaction.objectStore("images").delete(id);
    await done;
  } finally {
    database.close();
  }
}

export async function prepareSkinImage(skin: ImportedSkin): Promise<ImportedSkin> {
  const bitmap = await createImageBitmap(skin.image);
  try {
    const tooLarge =
      bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 40_000_000;
    if (tooLarge)
      throw new SkinImportError("Background image exceeds 40 megapixels or 16384 pixels per side.");
    const canvas = document.createElement("canvas");
    const scale = Math.min(240 / bitmap.width, 160 / bitmap.height);
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new SkinImportError("Unable to preview this image.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { ...skin, thumbnail: canvas.toDataURL("image/jpeg", 0.75) };
  } finally {
    bitmap.close();
  }
}
