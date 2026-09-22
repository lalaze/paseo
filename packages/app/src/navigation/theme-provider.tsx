import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { useMemo, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";

function NavigationThemeProviderBase({
  children,
  dark,
  background,
}: {
  children: ReactNode;
  dark: boolean;
  background: string;
}) {
  const value = useMemo(() => {
    const base = dark ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, background } };
  }, [dark, background]);
  // Stack contentStyle does not reach React Navigation's outer Screen background.
  return <ThemeProvider value={value}>{children}</ThemeProvider>;
}

export const NavigationThemeProvider = withUnistyles(NavigationThemeProviderBase, (theme) => ({
  dark: theme.colorScheme === "dark",
  background: theme.colors.surfaceCanvas,
}));
