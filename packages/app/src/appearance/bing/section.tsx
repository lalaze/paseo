import { useCallback } from "react";
import { Text, View, Linking } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useBingWallpaper } from "./use-wallpaper";

function openWallpaperLibrary() {
  router.push("/settings/wallpapers");
}

export function BingWallpaperSection() {
  const { t } = useTranslation();
  const bing = useBingWallpaper();
  const copyrightUrl = bing.wallpaper?.copyrightUrl;
  const openAttribution = useCallback(() => {
    if (copyrightUrl) void Linking.openURL(copyrightUrl);
  }, [copyrightUrl]);
  const showDetails = bing.enabled || !bing.available || bing.busy || Boolean(bing.error);
  return (
    <SettingsSection title={t("settings.appearance.bing.title")}>
      <View style={settingsStyles.card}>
        <SettingsSwitch
          label={t("settings.appearance.bing.enable")}
          hint={t("settings.appearance.bing.description")}
          value={bing.enabled}
          disabled={bing.selecting}
          onValueChange={bing.setEnabled}
        />
        {showDetails ? (
          <View style={styles.details}>
            {!bing.available ? (
              <Text style={settingsStyles.rowHint}>
                {t("settings.appearance.bing.unavailable")}
              </Text>
            ) : null}
            {bing.busy ? (
              <Text role="status" style={settingsStyles.rowHint}>
                {t("settings.appearance.bing.loading")}
              </Text>
            ) : null}
            {bing.error ? (
              <Text role="alert" style={styles.error}>
                {t("settings.appearance.bing.failed", { reason: bing.error })}
              </Text>
            ) : null}
            {bing.enabled && bing.wallpaper ? (
              <>
                <Text style={settingsStyles.rowHint}>
                  {t(
                    bing.selectedId
                      ? "settings.appearance.bing.pinned"
                      : "settings.appearance.bing.daily",
                  )}
                </Text>
                <Text style={settingsStyles.rowTitle}>{bing.wallpaper.title}</Text>
                <Text style={settingsStyles.rowHint}>{bing.wallpaper.copyright}</Text>
              </>
            ) : null}
            {bing.enabled ? (
              <View style={styles.actions}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bing.busy || !bing.available}
                  onPress={bing.refresh}
                >
                  {t("settings.appearance.bing.refresh")}
                </Button>
                {bing.selectedId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bing.selecting}
                    onPress={bing.resumeDaily}
                  >
                    {t("settings.appearance.bing.resume")}
                  </Button>
                ) : null}
                {copyrightUrl ? (
                  <Button size="sm" variant="outline" onPress={openAttribution}>
                    {t("settings.appearance.bing.attribution")}
                  </Button>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        <View style={styles.details}>
          <Button
            variant="outline"
            size="sm"
            onPress={openWallpaperLibrary}
            testID="wallpaper-library-link"
          >
            {t("settings.appearance.bing.archive")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: { padding: theme.spacing[4], gap: theme.spacing[2], alignItems: "flex-start" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
