import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Image,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { useBingWallpaper } from "./use-wallpaper";
import { useArchiveImage } from "./use-archive-image";
import type { ArchivedWallpaper } from "./archive";

const MIN_COLUMN_WIDTH = 280;
const PAGE_SIZE = 12;
// Start rendering the next page once the bottom is this close to the viewport.
const LOAD_AHEAD = 800;

interface WallpaperLibraryPageProps {
  onBack: () => void;
  showBack: boolean;
  /** The desktop settings page title, rendered inside this page's own scroll view. */
  title?: ReactNode;
}

interface WallpaperColumn {
  key: string;
  entries: ArchivedWallpaper[];
}

// Every card has the same 16:9 height, so dealing entries round-robin keeps columns
// balanced and reading order left-to-right, newest first.
function layoutColumns(entries: ArchivedWallpaper[], columnCount: number): WallpaperColumn[] {
  const columns: WallpaperColumn[] = Array.from({ length: columnCount }, (_, index) => ({
    key: `column-${index}`,
    entries: [],
  }));
  entries.forEach((entry, index) => columns[index % columnCount].entries.push(entry));
  return columns;
}

export function WallpaperLibraryPage({ onBack, showBack, title }: WallpaperLibraryPageProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bing = useBingWallpaper();
  const total = bing.entries.length;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [galleryWidth, setGalleryWidth] = useState(0);
  const viewportHeight = useRef(0);
  const scrollOffset = useRef(0);
  const contentHeight = useRef(0);

  const loadMore = useCallback(
    () => setVisibleCount((count) => (count < total ? count + PAGE_SIZE : count)),
    [total],
  );
  const loadMoreIfNearEnd = useCallback(() => {
    if (viewportHeight.current === 0 || contentHeight.current === 0) return;
    const remaining = contentHeight.current - scrollOffset.current - viewportHeight.current;
    if (remaining < LOAD_AHEAD) loadMore();
  }, [loadMore]);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffset.current = event.nativeEvent.contentOffset.y;
      contentHeight.current = event.nativeEvent.contentSize.height;
      loadMoreIfNearEnd();
    },
    [loadMoreIfNearEnd],
  );
  // Keeps loading until the content overflows the viewport, so tall or wide windows fill up.
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeight.current = height;
      loadMoreIfNearEnd();
    },
    [loadMoreIfNearEnd],
  );
  const measureViewport = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeight.current = event.nativeEvent.layout.height;
      loadMoreIfNearEnd();
    },
    [loadMoreIfNearEnd],
  );
  const measureGallery = useCallback(
    (event: LayoutChangeEvent) => setGalleryWidth(event.nativeEvent.layout.width),
    [],
  );
  const columnCount = Math.max(1, Math.floor(galleryWidth / MIN_COLUMN_WIDTH));
  const columns = useMemo(
    () => layoutColumns(bing.entries.slice(0, visibleCount), columnCount),
    [bing.entries, visibleCount, columnCount],
  );
  const contentStyle = useMemo(
    () => [styles.scrollContent, { paddingBottom: insets.bottom }],
    [insets.bottom],
  );

  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={contentStyle}
      onLayout={measureViewport}
      onScroll={handleScroll}
      onContentSizeChange={handleContentSizeChange}
      scrollEventThrottle={100}
    >
      {title}
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
          <View style={styles.gallery} onLayout={measureGallery}>
            {galleryWidth > 0
              ? columns.map((column) => (
                  <View key={column.key} style={styles.column}>
                    {column.entries.map((entry) => (
                      <ArchiveCard key={entry.id} entry={entry} />
                    ))}
                  </View>
                ))
              : null}
          </View>
        </View>
      </SettingsCard>
    </ScrollView>
  );
}

interface ArchiveCardProps {
  entry: ArchivedWallpaper;
}

function ArchiveCard({ entry }: ArchiveCardProps) {
  const { t } = useTranslation();
  const bing = useBingWallpaper();
  const image = useArchiveImage(entry.id);
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const source = useMemo(() => ({ uri: image.data ?? undefined }), [image.data]);
  const { selectArchive, deleteArchive } = bing;
  const apply = useCallback(() => selectArchive(entry.id), [selectArchive, entry.id]);
  const remove = useCallback(() => deleteArchive(entry.id), [deleteArchive, entry.id]);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const showDetails = isHovered || isNative || isCompact;
  const date = `${entry.date.slice(0, 4)}-${entry.date.slice(4, 6)}-${entry.date.slice(6, 8)}`;
  return (
    <View
      style={styles.archiveCard}
      testID="bing-archive-card"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {image.data ? (
        <Image
          source={source}
          testID="bing-archive-preview"
          style={styles.preview}
          resizeMode="cover"
          accessibilityLabel={entry.title}
        />
      ) : (
        <View style={[styles.preview, styles.previewPlaceholder]}>
          {image.error ? (
            <Text style={styles.error}>{t("settings.appearance.bing.imageFailed")}</Text>
          ) : null}
        </View>
      )}
      {/* Hidden with opacity only: on web the pointer is already over the card whenever it can reach these buttons. */}
      <View style={[styles.overlay, showDetails ? null : styles.overlayHidden]}>
        <View style={styles.overlayActions}>
          <Button
            size="xs"
            accessibilityLabel={t("settings.appearance.bing.apply", { name: entry.title })}
            disabled={
              bing.selecting || !image.data || (bing.enabled && bing.selectedId === entry.id)
            }
            onPress={apply}
          >
            {t("settings.appearance.bing.applyAction")}
          </Button>
          <Button
            size="xs"
            accessibilityLabel={t("settings.appearance.bing.delete", { name: entry.title })}
            disabled={
              bing.selecting ||
              bing.busy ||
              bing.currentId === entry.id ||
              bing.latestId === entry.id ||
              bing.selectedId === entry.id
            }
            onPress={remove}
          >
            {t("settings.appearance.bing.deleteAction")}
          </Button>
        </View>
        <View style={styles.overlayInfo}>
          <Text style={styles.overlayTitle} numberOfLines={1}>
            {entry.title}
          </Text>
          <Text style={styles.overlayHint} numberOfLines={1}>
            {date}
          </Text>
          <Text style={styles.overlayHint} numberOfLines={2}>
            {entry.copyright}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrollView: { flex: 1 },
  scrollContent: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    gap: theme.spacing[4],
  },
  details: { padding: theme.spacing[4], gap: theme.spacing[4] },
  back: { alignSelf: "flex-start" },
  gallery: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[4] },
  column: { flex: 1, minWidth: 0, gap: theme.spacing[4] },
  archiveCard: {
    position: "relative",
    aspectRatio: 16 / 9,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  preview: { width: "100%", height: "100%" },
  previewPlaceholder: {
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "space-between" },
  overlayHidden: { opacity: 0 },
  overlayActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  overlayInfo: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    // Fixed dark scrim: the text sits on a photo, so it stays white in every theme.
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  overlayTitle: {
    color: theme.colors.palette.white,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  overlayHint: { color: "rgba(255, 255, 255, 0.75)", fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
