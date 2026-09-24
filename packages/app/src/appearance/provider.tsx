import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";
import { UnistylesRuntime } from "react-native-unistyles";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import {
  rememberPluginThemeHost,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import {
  PLUGIN_THEME_NAMES,
  REGISTERED_THEMES,
  darkTheme,
  lightTheme,
  PLUGIN_THEME_PREFERENCE,
  SKIN_THEME_NAMES,
  THEME_TO_UNISTYLES,
} from "@/styles/theme";
import { applyAppearance } from "./apply";
import { useSkinLibrary } from "./skins/use-library";
import { buildSkinTheme } from "./skins/theme";
import { SkinBackground } from "./skins/background";
import { buildImageBackgroundTheme } from "./background-theme";
import { BingBackground } from "./bing/background";
import { BingWallpaperContext, useBingWallpaperController } from "./bing/use-wallpaper";
import { NavigationThemeProvider } from "@/navigation/theme-provider";

interface ContributedThemes {
  options: PluginThemeOption[];
  selected: PluginThemeOption | null;
  select: (option: PluginThemeOption) => Promise<void>;
}

interface ApplyThemeInput {
  preference: AppSettings["theme"];
  contributedTheme: PluginThemeOption | null;
}

const ContributedThemesContext = createContext<ContributedThemes | null>(null);

function applyTheme({ preference, contributedTheme }: ApplyThemeInput): void {
  if (contributedTheme) {
    const themeName = PLUGIN_THEME_NAMES[contributedTheme.theme.colorScheme];
    UnistylesRuntime.updateTheme(themeName, () => contributedTheme.theme);
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(themeName);
    return;
  }

  const builtInPreference =
    preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtInPreference === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    return;
  }

  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[builtInPreference]);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const [hasAppliedAppearance, setHasAppliedAppearance] = useState(false);
  const options = usePluginThemeCatalog();
  const skinLibrary = useSkinLibrary();
  const bing = useBingWallpaperController();
  const colorScheme = useColorScheme();
  const activeSkin = bing.enabled ? null : skinLibrary.data?.active;
  const skinTheme = useMemo(() => (activeSkin ? buildSkinTheme(activeSkin) : null), [activeSkin]);
  const selected = useMemo(() => {
    if (settings.theme !== PLUGIN_THEME_PREFERENCE) return null;
    return options.find((option) => option.id === settings.pluginThemeId) ?? null;
  }, [options, settings.pluginThemeId, settings.theme]);

  const builtInPreference =
    settings.theme === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : settings.theme;
  const systemTheme = colorScheme === "light" ? lightTheme : darkTheme;
  const builtInTheme =
    builtInPreference === "auto"
      ? systemTheme
      : REGISTERED_THEMES[THEME_TO_UNISTYLES[builtInPreference]];
  const baseTheme = selected?.theme ?? builtInTheme;
  const hasWallpaper = bing.enabled && Boolean(bing.wallpaper);
  const imageTheme = useMemo(
    () => (hasWallpaper ? buildImageBackgroundTheme(baseTheme) : skinTheme),
    [hasWallpaper, baseTheme, skinTheme],
  );

  useEffect(() => {
    if (isLoading || skinLibrary.isPending) return;
    if (imageTheme) {
      const name = SKIN_THEME_NAMES[imageTheme.colorScheme];
      UnistylesRuntime.updateTheme(name, () => imageTheme);
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(name);
    } else {
      applyTheme({ preference: settings.theme, contributedTheme: selected });
    }
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      syntaxTheme: settings.syntaxTheme,
    });
    setHasAppliedAppearance(true);
  }, [
    isLoading,
    skinLibrary.isPending,
    imageTheme,
    selected,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.syntaxTheme,
  ]);

  const select = useCallback(
    (option: PluginThemeOption) => {
      rememberPluginThemeHost(option);
      return updateSettings({
        theme: PLUGIN_THEME_PREFERENCE,
        pluginThemeId: option.id,
      });
    },
    [updateSettings],
  );
  const value = useMemo(() => ({ options, selected, select }), [options, selected, select]);

  // The first settings load changes appearance keys. Mount screens only after applying it
  // so startup does not destroy and recreate an already-visible workspace.
  if (!hasAppliedAppearance) return null;

  return (
    <ContributedThemesContext.Provider value={value}>
      <BingWallpaperContext.Provider value={bing}>
        <SkinBackground disabled={bing.enabled} />
        <BingBackground
          url={bing.enabled ? bing.imageUrl : null}
          imageAttempt={bing.imageAttempt}
          color={baseTheme.colors.surface0}
          onError={bing.imageFailed}
          onLoad={bing.imageLoaded}
        >
          <NavigationThemeProvider>{children}</NavigationThemeProvider>
        </BingBackground>
      </BingWallpaperContext.Provider>
    </ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
