import { useCallback, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { useBingWallpaper } from "./use-wallpaper";
import { useArchiveImage } from "./use-archive-image";
import type { ArchivedWallpaper } from "./archive";

interface WallpaperLibraryPageProps {
  onBack: () => void;
  showBack: boolean;
}

export function WallpaperLibraryPage({ onBack, showBack }: WallpaperLibraryPageProps) {
  const { t } = useTranslation();
  const bing = useBingWallpaper();
  const [visibleCount, setVisibleCount] = useState(12);
  const showMore = useCallback(() => setVisibleCount((count) => count + 12), []);
  return (
    <View style={styles.page}>
      {showBack ? (
        <Button variant="ghost" size="sm" leftIcon={ArrowLeft} onPress={onBack} style={styles.back}>
          {t("settings.appearance.bing.back")}
        </Button>
      ) : null}
      <SettingsCard>
        <View style={styles.details}>
          <Text style={settingsStyles.rowHint}>
            {t("settings.appearance.bing.archiveDescription")}
          </Text>
          {bing.enabled ? (
            <View style={styles.actions}>
              <Text style={settingsStyles.rowHint}>
                {t(
                  bing.selectedId
                    ? "settings.appearance.bing.pinned"
                    : "settings.appearance.bing.daily",
                )}
              </Text>
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
            </View>
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
      </SettingsCard>
    </View>
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
  page: { gap: theme.spacing[4] },
  details: { padding: theme.spacing[4], gap: theme.spacing[4] },
  back: { alignSelf: "flex-start" },
  gallery: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[4] },
  archiveCard: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 260,
    maxWidth: 400,
    gap: theme.spacing[2],
  },
  preview: { width: "100%", aspectRatio: 16 / 9, borderRadius: theme.borderRadius.md },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
