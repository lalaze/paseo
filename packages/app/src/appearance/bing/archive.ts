import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { BingWallpaperSchema, type BingWallpaper } from "@getpaseo/protocol/messages";
import { saveArchiveImage, deleteArchiveImage } from "./image-storage";

const entrySchema = BingWallpaperSchema.extend({
  id: z.string().regex(/^OHR\.[A-Za-z0-9_-]+_1920x1080\.jpg$/),
});
const archiveSchema = z.object({
  entries: z.array(entrySchema),
  selectedId: z.string().nullable(),
});
export type ArchivedWallpaper = z.infer<typeof entrySchema>;
export type WallpaperArchive = z.infer<typeof archiveSchema>;
export const ARCHIVE_KEY = ["bing-wallpaper-archive"];
export const ARCHIVE_STORAGE_KEY = "@paseo:bing-wallpaper-archive";
const EMPTY_ARCHIVE: WallpaperArchive = { entries: [], selectedId: null };

export function wallpaperId(wallpaper: BingWallpaper): string {
  const id = new URL(wallpaper.url).searchParams.get("id");
  if (!id || id.length > 180 || !/^OHR\.[A-Za-z0-9_-]+_1920x1080\.jpg$/.test(id)) {
    throw new Error("Invalid Bing image ID");
  }
  return id;
}

export async function readWallpaperArchive(): Promise<WallpaperArchive> {
  const saved = await AsyncStorage.getItem(ARCHIVE_STORAGE_KEY);
  return saved ? archiveSchema.parse(JSON.parse(saved)) : EMPTY_ARCHIVE;
}

let writes = Promise.resolve();
function updateArchive(
  update: (archive: WallpaperArchive) => Promise<WallpaperArchive>,
): Promise<void> {
  const previous = writes;
  const write = (async () => {
    await previous;
    const archive = await readWallpaperArchive();
    const next = await update(archive);
    await AsyncStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(next));
  })();
  writes = write.catch(() => undefined);
  return write;
}

export function archiveWallpaper(
  wallpaper: BingWallpaper,
  download: () => Promise<string>,
): Promise<void> {
  const metadata = BingWallpaperSchema.parse(wallpaper);
  const id = wallpaperId(metadata);
  return updateArchive(async (archive) => {
    if (archive.entries.some((entry) => entry.id === id)) return archive;
    const base64 = await download();
    await saveArchiveImage(id, base64);
    const entries = [{ ...metadata, id }, ...archive.entries];
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return { ...archive, entries };
  });
}

export function selectArchivedWallpaper(id: string | null): Promise<void> {
  return updateArchive(async (archive) => {
    if (id !== null && !archive.entries.some((entry) => entry.id === id)) {
      throw new Error("Archived wallpaper no longer exists");
    }
    return { ...archive, selectedId: id };
  });
}

export function removeArchivedWallpaper(id: string): Promise<void> {
  return updateArchive(async (archive) => {
    if (archive.selectedId === id) throw new Error("Cannot delete the selected wallpaper");
    await deleteArchiveImage(id);
    return { ...archive, entries: archive.entries.filter((entry) => entry.id !== id) };
  });
}
