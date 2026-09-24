import { useCallback, useMemo, useState } from "react";
import { Text, View, Linking, Image } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useBingWallpaper } from "./use-wallpaper";
import { useArchiveImage } from "./use-archive-image";
import type { ArchivedWallpaper } from "./archive";

export function BingWallpaperSection() {
  const { t } = useTranslation();
  const bing = useBingWallpaper();
  const [visibleCount, setVisibleCount] = useState(12);
  const showMore = useCallback(() => setVisibleCount((count) => count + 12), []);
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
          <Text style={settingsStyles.rowTitle}>{t("settings.appearance.bing.archive")}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.appearance.bing.archiveDescription")}
          </Text>
          {bing.entries.length === 0 ? (
            <Text style={settingsStyles.rowHint}>{t("settings.appearance.bing.empty")}</Text>
          ) : null}
          <View style={styles.gallery}>
            {bing.entries.slice(0, visibleCount).map((entry) => (
              <ArchiveCard key={entry.id} entry={entry} />
            ))}
          </View>
          {bing.entries.length > visibleCount ? (
            <Button size="sm" variant="outline" onPress={showMore}>
              {t("settings.appearance.bing.more")}
            </Button>
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}

function ArchiveCard({ entry }: { entry: ArchivedWallpaper }) {
  const { t } = useTranslation();
  const bing = useBingWallpaper();
  const image = useArchiveImage(entry.id);
  const source = useMemo(() => ({ uri: image.data ?? undefined }), [image.data]);
  const { selectArchive, deleteArchive } = bing;
  const apply = useCallback(() => selectArchive(entry.id), [selectArchive, entry.id]);
  const remove = useCallback(() => deleteArchive(entry.id), [deleteArchive, entry.id]);
  const date = `${entry.date.slice(0, 4)}-${entry.date.slice(4, 6)}-${entry.date.slice(6, 8)}`;
  return (
    <View style={styles.archiveCard} testID="bing-archive-card">
      {image.data ? (
        <Image
          source={source}
          testID="bing-archive-preview"
          style={styles.preview}
          resizeMode="cover"
          accessibilityLabel={entry.title}
        />
      ) : null}
      <Text style={settingsStyles.rowTitle}>{entry.title}</Text>
      <Text style={settingsStyles.rowHint}>{date}</Text>
      <Text style={settingsStyles.rowHint}>{entry.copyright}</Text>
      {image.error ? (
        <Text style={styles.error}>{t("settings.appearance.bing.imageFailed")}</Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={bing.selecting || !image.data || (bing.enabled && bing.selectedId === entry.id)}
          onPress={apply}
        >
          {t("settings.appearance.bing.apply", { name: entry.title })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            bing.selecting ||
            bing.busy ||
            bing.currentId === entry.id ||
            bing.latestId === entry.id ||
            bing.selectedId === entry.id
          }
          onPress={remove}
        >
          {t("settings.appearance.bing.delete", { name: entry.title })}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  gallery: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[4] },
  archiveCard: { flexGrow: 1, flexBasis: 260, maxWidth: 400, gap: theme.spacing[2] },
  preview: { width: "100%", aspectRatio: 16 / 9, borderRadius: theme.borderRadius.md },
  details: { padding: theme.spacing[4], gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
