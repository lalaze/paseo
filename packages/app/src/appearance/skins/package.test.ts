import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readSkinPackage, skinDigest } from "./package";
import { buildSkinTheme } from "./theme";

const image = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=",
    "base64",
  ),
);
const theme = {
  schemaVersion: 1,
  id: "test-skin",
  name: "Mountain",
  image: "background.png",
  appearance: "dark",
  art: { focusX: 0.8, taskMode: "ambient" },
};

describe("Dream Skin package import", () => {
  it("imports the original image and focal point from a wrapped Dream Skin ZIP", async () => {
    const archive = zipSync({
      "mountain/theme.json": strToU8(JSON.stringify(theme)),
      "mountain/background.png": image,
      "mountain/theme.css": strToU8("body { display: none; }"),
    });
    const skin = await readSkinPackage(archive);
    expect(skin.name).toBe("Mountain");
    expect(skin.focusX).toBe(0.8);
    expect(skin.strength).toBe(0.3);
    expect(new Uint8Array(await skin.image.arrayBuffer())).toEqual(image);
    expect(skin).not.toHaveProperty("css");
  });

  it("checks manifest hashes and retains the original author and license", async () => {
    const themeBytes = strToU8(JSON.stringify(theme));
    const manifest = {
      packageVersion: 1,
      skinApiVersion: 1,
      themeId: theme.id,
      publisher: { displayName: "Artist" },
      license: "CC-BY-4.0",
      provenance: { summary: "Original artwork" },
      files: [
        { path: "theme.json", bytes: themeBytes.length, sha256: await skinDigest(themeBytes) },
        { path: "background.png", bytes: image.length, sha256: await skinDigest(image) },
      ],
    };
    const archive = zipSync({
      "theme.json": themeBytes,
      "background.png": image,
      "manifest.json": strToU8(JSON.stringify(manifest)),
    });
    const skin = await readSkinPackage(archive);
    expect(skin.author).toBe("Artist");
    expect(skin.license).toBe("CC-BY-4.0");
    expect(skin.provenance).toBe("Original artwork");
    manifest.files[1].sha256 = "0".repeat(64);
    const tampered = zipSync({
      "theme.json": themeBytes,
      "background.png": image,
      "manifest.json": strToU8(JSON.stringify(manifest)),
    });
    await expect(readSkinPackage(tampered)).rejects.toThrow("integrity check failed");
  });

  it.each(["../theme.json", "/theme.json", "a/b/theme.json", "a\\theme.json"])(
    "rejects unsafe archive entry %s",
    async (name) => {
      await expect(readSkinPackage(zipSync({ [name]: strToU8("{}") }))).rejects.toThrow(
        "invalid path",
      );
    },
  );

  it("rejects an oversized expanded file even when highly compressed", async () => {
    const archive = zipSync({ "theme.css": new Uint8Array(300_000) });
    await expect(readSkinPackage(archive)).rejects.toThrow("size limit");
  });

  it("rejects unsupported versions, missing artwork and executable payloads", async () => {
    await expect(
      readSkinPackage(
        zipSync({
          "theme.json": strToU8(JSON.stringify({ ...theme, schemaVersion: 2 })),
          "background.png": image,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      readSkinPackage(zipSync({ "theme.json": strToU8(JSON.stringify(theme)) })),
    ).rejects.toThrow("exactly one");
    await expect(readSkinPackage(zipSync({ "run.js": strToU8("alert(1)") }))).rejects.toThrow(
      "Unsupported theme file",
    );
  });

  it("rejects CSS in declared color values", async () => {
    const colors = {
      background: "url(https://example.com)",
      panel: "#111",
      panelAlt: "#222",
      accent: "#fff",
      text: "#fff",
      muted: "#aaa",
      line: "#333",
    };
    await expect(
      readSkinPackage(
        zipSync({
          "theme.json": strToU8(JSON.stringify({ ...theme, colors })),
          "background.png": image,
        }),
      ),
    ).rejects.toThrow();
  });

  it("resolves auto appearance from the image pack's palette", async () => {
    const colors = {
      background: "rgba(240, 238, 230, 0.9)",
      panel: "#fff",
      panelAlt: "#eee",
      accent: "#456",
      text: "#123",
      muted: "#567",
      line: "#ddd",
    };
    const archive = zipSync({
      "theme.json": strToU8(JSON.stringify({ ...theme, appearance: "auto", colors })),
      "background.png": image,
    });
    const imported = await readSkinPackage(archive);
    expect(imported.appearance).toBe("light");
    expect(imported.colors?.background).toBe("#f0eee6");
    const adapted = buildSkinTheme(imported);
    expect(adapted.conversation.textShadow).toBe("0 1px 2px rgba(255, 255, 255, 0.65)");
    expect(adapted.colors.foreground).toBe("#112233");
    expect(adapted.conversation.toolForeground).toBe("#112233");
    expect(adapted.conversation.toolExpandedBackground).toBe("transparent");
    expect(adapted.conversation.toolDetailBorder).toBe("transparent");
    expect(adapted.colors.popover).toBe("#f0eee6");
  });

  it("composites translucent tokens for solid Paseo controls", async () => {
    const colors = {
      background: "#000",
      panel: "rgba(255, 255, 255, 0.1)",
      panelAlt: "#fff2",
      accent: "rgb(100, 120, 140)",
      text: "#fff",
      muted: "#aaa",
      line: "#ffffff20",
    };
    const imported = await readSkinPackage(
      zipSync({
        "theme.json": strToU8(JSON.stringify({ ...theme, colors })),
        "background.png": image,
      }),
    );
    expect(imported.colors).toMatchObject({
      panel: "#1a1a1a",
      panelAlt: "#222222",
      accent: "#64788c",
      line: "#202020",
    });
    const adapted = buildSkinTheme(imported);
    expect(adapted.colors.surfaceCanvas).toBe("transparent");
    expect(adapted.colors.surfaceSidebarCanvas).toBe("rgba(26, 26, 26, 0.5)");
    expect(adapted.colors.surfaceSidebar).toBe("#000000");
    expect(adapted.colors.surface0).toBe("#000000");
    expect(adapted.colors.surface1).toBe("#1a1a1a");
  });
});
