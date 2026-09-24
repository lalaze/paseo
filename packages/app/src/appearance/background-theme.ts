import type { Theme, ConversationMaterial } from "@/styles/theme";
import { translucentSkinColor } from "./skins/color";

export function buildImageBackgroundTheme(themed: Theme): Theme {
  const light = themed.colorScheme === "light";
  const panel = themed.colors.surface1;
  const conversation: ConversationMaterial = {
    userBackground: translucentSkinColor(themed.colors.surface2, light ? 0.9 : 0.78),
    textShadow: light ? "0 1px 2px rgba(255, 255, 255, 0.65)" : "0 1px 3px rgba(0, 0, 0, 0.8)",
    toolForeground: themed.colors.foreground,
    toolExpandedBackground: "transparent",
    toolDetailBorder: "transparent",
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
