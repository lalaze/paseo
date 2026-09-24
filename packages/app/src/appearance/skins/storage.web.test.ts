import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { readSkinLibrary, removeSkin, saveSkin, selectSkin } from "./storage.web";
import type { ImportedSkin } from "./model";

import {
  archiveWallpaper,
  readWallpaperArchive,
  selectArchivedWallpaper,
  removeArchivedWallpaper,
  wallpaperId,
} from "../bing/archive";
import { readArchiveImage } from "../bing/image-storage.web";

const metadata = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => metadata.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      metadata.set(key, value);
    },
  },
}));
vi.mock("../bing/image-storage", () => import("../bing/image-storage.web"));

const skin: ImportedSkin = {
  id: "a".repeat(64),
  name: "Mountain",
  appearance: "dark",
  colors: null,
  focusX: 0.8,
  focusY: 0.5,
  strength: 0.3,
  author: "Artist",
  license: "MIT",
  provenance: "",
  thumbnail: "data:image/png;base64,test",
  image: new Blob(["image"], { type: "image/png" }),
};

beforeEach(() => {
  metadata.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => vi.unstubAllGlobals());

describe("device skin library", () => {
  it("persists imports, selection and strength without storing image bytes in settings", async () => {
    await saveSkin(skin);
    await saveSkin(skin);
    await selectSkin(skin.id, 0.65);
    const restored = await readSkinLibrary();
    expect(restored.skins).toHaveLength(1);
    expect(restored.skins[0]).not.toHaveProperty("image");
    expect(restored.active?.id).toBe(skin.id);
    expect(await restored.active?.image.text()).toBe("image");
    expect(restored.strength).toBe(0.65);
    expect(restored.skins[0].strength).toBe(0.65);
  });

  it("restores default without deleting the library and clears an active removed skin", async () => {
    await saveSkin(skin);
    await selectSkin(null, 0.3);
    expect((await readSkinLibrary()).active).toBeNull();
    expect((await readSkinLibrary()).skins).toHaveLength(1);
    await selectSkin(skin.id, 0.3);
    await removeSkin(skin.id);
    expect(await readSkinLibrary()).toEqual({ skins: [], active: null, strength: 0.3 });
  });
});

describe("device wallpaper archive", () => {
  const older = {
    date: "202609221600",
    url: "https://www.bing.com/th?id=OHR.Older_EN-US123_1920x1080.jpg",
    title: "Older coast",
    copyright: "© Photographer",
    copyrightUrl: "https://www.bing.com/search?q=coast",
  };
  const newer = {
    ...older,
    date: "202609231600",
    url: "https://www.bing.com/th?id=OHR.Newer_EN-US123_1920x1080.jpg",
    title: "New coast",
  };

  it("archives concurrent updates once, preserves pinned selection, and restores local image bytes", async () => {
    const download = vi.fn(async () => "jpeg-bytes");
    await Promise.all([archiveWallpaper(older, download), archiveWallpaper(older, download)]);
    expect(download).toHaveBeenCalledTimes(1);
    await selectArchivedWallpaper(wallpaperId(older));
    await archiveWallpaper(newer, download);
    const restored = await readWallpaperArchive();
    expect(restored.selectedId).toBe(wallpaperId(older));
    expect(restored.entries.map((entry) => entry.title)).toEqual(["New coast", "Older coast"]);
    expect(await readArchiveImage(wallpaperId(older))).toBe("data:image/jpeg;base64,jpeg-bytes");
    expect(JSON.stringify(restored)).not.toContain("jpeg-bytes");
    await expect(removeArchivedWallpaper(wallpaperId(older))).rejects.toThrow("selected wallpaper");
    await selectArchivedWallpaper(null);
    await removeArchivedWallpaper(wallpaperId(older));
    expect(await readArchiveImage(wallpaperId(older))).toBeNull();
    expect((await readWallpaperArchive()).entries.map((entry) => entry.title)).toEqual([
      "New coast",
    ]);
  });

  it("retains the previous wallpaper on download failure and allows retry", async () => {
    await archiveWallpaper(older, async () => "old-image");
    await expect(
      archiveWallpaper(newer, async () => {
        throw new Error("Offline");
      }),
    ).rejects.toThrow("Offline");
    expect((await readWallpaperArchive()).entries.map((entry) => entry.title)).toEqual([
      "Older coast",
    ]);
    await archiveWallpaper(newer, async () => "new-image");
    expect((await readWallpaperArchive()).entries).toHaveLength(2);
  });
});
