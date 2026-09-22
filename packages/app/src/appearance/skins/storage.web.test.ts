import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { readSkinLibrary, removeSkin, saveSkin, selectSkin } from "./storage.web";
import type { ImportedSkin } from "./model";

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

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
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
