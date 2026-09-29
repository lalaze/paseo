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
import { settingsStyles } from "@/styles/settings";
import { useBingWallpaper } from "./use-wallpaper";
import { useArchiveImage } from "./use-archive-image";
import type { ArchivedWallpaper } from "./archive";

const MIN_COLUMN_WIDTH = 280;
const PAGE_SIZE = 12;
// Start rendering the next page once the bottom is this close to the viewport.
const LOAD_AHEAD = 800;
// Height guess for text and buttons below the preview until the card reports its real height.
const ESTIMATED_CARD_TEXT_HEIGHT = 150;

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

// Places each entry in the currently shortest column so columns stay balanced
// while reading order stays roughly left-to-right, newest first.
function layoutColumns(
  entries: ArchivedWallpaper[],
  columnCount: number,
  columnWidth: number,
  heights: Record<string, number>,
): WallpaperColumn[] {
  const columns: WallpaperColumn[] = Array.from({ length: columnCount }, (_, index) => ({
    key: `column-${index}`,
    entries: [],
  }));
  const columnHeights = Array.from({ length: columnCount }, () => 0);
  const estimate = (columnWidth * 9) / 16 + ESTIMATED_CARD_TEXT_HEIGHT;
  for (const entry of entries) {
    const shortest = columnHeights.indexOf(Math.min(...columnHeights));
    columns[shortest].entries.push(entry);
    columnHeights[shortest] += heights[entry.id] ?? estimate;
  }
  return columns;
}

export function WallpaperLibraryPage({ onBack, showBack, title }: WallpaperLibraryPageProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bing = useBingWallpaper();
  const total = bing.entries.length;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [galleryWidth, setGalleryWidth] = useState(0);
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
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
  const recordCardHeight = useCallback((id: string, height: number) => {
    const rounded = Math.round(height);
    setCardHeights((prev) => (prev[id] === rounded ? prev : { ...prev, [id]: rounded }));
  }, []);

  const columnCount = Math.max(1, Math.floor(galleryWidth / MIN_COLUMN_WIDTH));
  const columns = useMemo(
    () =>
      layoutColumns(
        bing.entries.slice(0, visibleCount),
        columnCount,
        galleryWidth / columnCount,
        cardHeights,
      ),
    [bing.entries, visibleCount, columnCount, galleryWidth, cardHeights],
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
                      <ArchiveCard key={entry.id} entry={entry} onMeasure={recordCardHeight} />
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
  onMeasure: (id: string, height: number) => void;
}

function ArchiveCard({ entry, onMeasure }: ArchiveCardProps) {
  const { t } = useTranslation();
  const bing = useBingWallpaper();
  const image = useArchiveImage(entry.id);
  const source = useMemo(() => ({ uri: image.data ?? undefined }), [image.data]);
  const { selectArchive, deleteArchive } = bing;
  const apply = useCallback(() => selectArchive(entry.id), [selectArchive, entry.id]);
  const remove = useCallback(() => deleteArchive(entry.id), [deleteArchive, entry.id]);
  const measure = useCallback(
    (event: LayoutChangeEvent) => onMeasure(entry.id, event.nativeEvent.layout.height),
    [onMeasure, entry.id],
  );
  const date = `${entry.date.slice(0, 4)}-${entry.date.slice(4, 6)}-${entry.date.slice(6, 8)}`;
  return (
    <View style={styles.archiveCard} testID="bing-archive-card" onLayout={measure}>
      {image.data ? (
        <Image
          source={source}
          testID="bing-archive-preview"
          style={styles.preview}
          resizeMode="cover"
          accessibilityLabel={entry.title}
        />
      ) : (
        <View style={[styles.preview, styles.previewPlaceholder]} />
      )}
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
  scrollView: { flex: 1 },
  scrollContent: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    gap: theme.spacing[4],
  },
  details: { padding: theme.spacing[4], gap: theme.spacing[4] },
  back: { alignSelf: "flex-start" },
  gallery: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[4] },
  column: { flex: 1, minWidth: 0, gap: theme.spacing[6] },
  archiveCard: { gap: theme.spacing[2] },
  preview: { width: "100%", aspectRatio: 16 / 9, borderRadius: theme.borderRadius.md },
  previewPlaceholder: { backgroundColor: theme.colors.surface2 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
