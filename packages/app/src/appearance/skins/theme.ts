import {
  buildDarkSemanticColors,
  buildDarkTheme,
  buildLightSemanticColors,
  buildLightTheme,
  darkTheme,
  lightTheme,
  type Theme,
  type ConversationMaterial,
} from "@/styles/theme";
import type { SkinMetadata } from "./model";
import { translucentSkinColor } from "./color";

export function buildSkinTheme(skin: SkinMetadata): Theme {
  const base = skin.appearance === "light" ? lightTheme : darkTheme;
  const palette = skin.colors;
  let themed: Theme = base;
  if (palette) {
    const config = {
      surface0: palette.background,
      surface1: palette.panel,
      surface2: palette.panelAlt,
      surface3: palette.panelAlt,
      surface4: palette.muted,
      surfaceDiffEmpty: palette.panel,
      surfaceSidebar: palette.background,
      foreground: palette.text,
      foregroundMuted: palette.muted,
      foregroundExtraMuted: palette.muted,
      border: palette.line,
      borderAccent: palette.line,
      accent: palette.accent,
      accentBright: palette.accentAlt ?? palette.accent,
      accentForeground: palette.background,
      destructive: base.colors.destructive,
      terminalBlack: palette.background,
      terminalBrightBlack: palette.muted,
      ring: palette.accent,
      primary: palette.text,
      primaryForeground: palette.background,
    };
    themed =
      skin.appearance === "light"
        ? buildLightTheme(buildLightSemanticColors(config))
        : buildDarkTheme(buildDarkSemanticColors(config));
  }
  const light = themed.colorScheme === "light";
  const panel = themed.colors.surface1;
  const conversation: ConversationMaterial = {
    userBackground: translucentSkinColor(themed.colors.surface2, light ? 0.9 : 0.78),
    textShadow: light ? "0 1px 2px rgba(255, 255, 255, 0.65)" : "0 1px 3px rgba(0, 0, 0, 0.8)",
    toolForeground: themed.colors.foreground,
    toolExpandedBackground: "transparent",
    composerBackground: translucentSkinColor(panel, light ? 0.9 : 0.74),
    chromeBackground: translucentSkinColor(panel, light ? 0.8 : 0.64),
    border: translucentSkinColor(themed.colors.accentBright, light ? 0.25 : 0.18),
    borderWidth: 1,
    blur: "blur(14px) saturate(110%)",
    shadow: `0 8px 28px ${translucentSkinColor(themed.colors.surface0, light ? 0.08 : 0.2)}`,
  };
  // Translucency belongs to owned conversation surfaces. Menus, code, terminals and
  // overlay sidebars retain solid tokens; they must not reveal content behind them.
  if (themed.colorScheme === "light")
    return {
      ...themed,
      conversation,
      colors: {
        ...themed.colors,
        surfaceCanvas: "transparent",
        surfaceWorkspace: "transparent",
        surfaceSidebarCanvas: translucentSkinColor(panel, 0.7),
      },
    };
  return {
    ...themed,
    conversation,
    colors: {
      ...themed.colors,
      surfaceCanvas: "transparent",
      surfaceWorkspace: "transparent",
      surfaceSidebarCanvas: translucentSkinColor(panel, 0.5),
    },
  };
}
