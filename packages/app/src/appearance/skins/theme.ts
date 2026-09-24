import {
  buildDarkSemanticColors,
  buildDarkTheme,
  buildLightSemanticColors,
  buildLightTheme,
  darkTheme,
  lightTheme,
  type Theme,
} from "@/styles/theme";
import type { SkinMetadata } from "./model";
import { buildImageBackgroundTheme } from "../background-theme";

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
  return buildImageBackgroundTheme(themed);
}
