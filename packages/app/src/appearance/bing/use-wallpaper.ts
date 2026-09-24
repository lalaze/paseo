import {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useReplicaQuery, useFetchQuery } from "@/data/query";
import { useAppVisible } from "@/hooks/use-app-visible";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import {
  BingWallpaperSchema,
  type BingWallpaper,
  type SessionInboundMessage,
} from "@getpaseo/protocol/messages";
import { useAppSettings } from "@/hooks/use-settings";
import { getHostRuntimeStore, useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { deactivateSkin } from "../skins/use-library";
import { SKIN_LIBRARY_KEY } from "../skins/model";
import {
  ARCHIVE_KEY,
  readWallpaperArchive,
  archiveWallpaper,
  selectArchivedWallpaper,
  removeArchivedWallpaper,
  type WallpaperArchive,
} from "./archive";
import { useArchiveImage } from "./use-archive-image";

type Market = Extract<
  SessionInboundMessage,
  { type: "appearance.bing.get_wallpaper.request" }
>["market"];
const markets: Record<string, Market> = {
  en: "en-US",
  "zh-CN": "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  fr: "fr-FR",
  es: "es-ES",
  "pt-BR": "pt-BR",
  ru: "ru-RU",
  ar: "ar-SA",
};
const REFRESH_INTERVAL = 60 * 60 * 1000;

function useWallpaperFeed(enabled: boolean) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const support = useHostFeatureMap(serverIds, "bingWallpaperArchive");
  const runtime = getHostRuntimeStore();
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeAll(listener),
    [runtime],
  );
  const getServerId = useCallback(
    () =>
      serverIds.find(
        (id) => support.get(id) && runtime.getSnapshot(id)?.connectionStatus === "online",
      ) ?? "",
    [runtime, serverIds, support],
  );
  const serverId = useSyncExternalStore(subscribe, getServerId, getServerId);
  const client = useHostRuntimeClient(serverId);
  const market = markets[i18n.resolvedLanguage ?? "en"] ?? "en-US";
  const cacheKey = ["bing-wallpaper-cache", market];
  const storageKey = `@paseo:bing-wallpaper:${market}`;
  const cached = useReplicaQuery({
    pushEvent: "local:bing-wallpaper-cached",
    networkMode: "always",
    queryKey: cacheKey,
    queryFn: () => readCachedWallpaper(storageKey),
  });
  const visible = useAppVisible();
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["bing-wallpaper", market],
    enabled: enabled && Boolean(client) && visible,
    queryFn: async () => {
      if (!client) throw new Error(t("settings.appearance.bing.unavailable"));
      const result = await client.getBingWallpaper(market);
      if (!result.wallpaper)
        throw new Error(result.error ?? t("settings.appearance.bing.imageFailed"));
      const save = async (wallpaper: BingWallpaper | null) => {
        if (!wallpaper) return;
        await archiveWallpaper(wallpaper, async () => {
          const image = await client.getBingWallpaperImage(wallpaper.url);
          if (!image.base64)
            throw new Error(image.error ?? t("settings.appearance.bing.imageFailed"));
          return image.base64;
        });
      };
      // Preserve the last cached image before replacing it on the first archive-enabled refresh.
      await save(await readCachedWallpaper(storageKey));
      await save(result.wallpaper);
      await queryClient.invalidateQueries({ queryKey: ARCHIVE_KEY });
      await queryClient.invalidateQueries({ queryKey: ["bing-wallpaper-image"] });
      await AsyncStorage.setItem(storageKey, JSON.stringify(result.wallpaper));
      queryClient.setQueryData(cacheKey, result.wallpaper);
      return result.wallpaper;
    },
    staleTimeMs: REFRESH_INTERVAL,
    refetchInterval: REFRESH_INTERVAL,
    retry: 1,
  });
  return { client, query, cached };
}

async function readCachedWallpaper(storageKey: string): Promise<BingWallpaper | null> {
  const saved = await AsyncStorage.getItem(storageKey);
  if (!saved) return null;
  try {
    const parsed = BingWallpaperSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function resolveWallpaper(archive: WallpaperArchive | undefined, latest: BingWallpaper | null) {
  const entries = archive?.entries ?? [];
  const selectedId = archive?.selectedId ?? null;
  const selected = entries.find((entry) => entry.id === selectedId);
  const wallpaper = selected ?? latest ?? entries[0] ?? null;
  const archived = selected ?? entries.find((entry) => entry.url === wallpaper?.url);
  const latestId = entries.find((entry) => entry.url === latest?.url)?.id ?? null;
  return { entries, selectedId, wallpaper, archived, latestId };
}

export function useBingWallpaperController() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const { client, query, cached } = useWallpaperFeed(settings.bingWallpaperEnabled);
  const archive = useReplicaQuery({
    pushEvent: "local:bing-wallpaper-archive",
    networkMode: "always",
    queryKey: ARCHIVE_KEY,
    queryFn: readWallpaperArchive,
  });
  const { entries, selectedId, wallpaper, archived, latestId } = resolveWallpaper(
    archive.data,
    query.data ?? cached.data ?? null,
  );
  const image = useArchiveImage(archived?.id ?? null);
  const [imageAttempt, setImageAttempt] = useState(0);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  type Action =
    | { type: "enable"; enabled: boolean }
    | { type: "select"; id: string | null }
    | { type: "delete"; id: string };
  const selection = useMutation({
    networkMode: "always",
    mutationFn: async (action: Action) => {
      if (action.type === "delete") {
        await removeArchivedWallpaper(action.id);
        queryClient.removeQueries({ queryKey: ["bing-wallpaper-image", action.id] });
      } else {
        const enabled = action.type === "select" || action.enabled;
        if (enabled) {
          if (!wallpaper) {
            if (!client) throw new Error(t("settings.appearance.bing.unavailable"));
            const result = await query.refetch();
            if (result.error) throw result.error;
          }
          await deactivateSkin();
          await queryClient.invalidateQueries({ queryKey: SKIN_LIBRARY_KEY });
        }
        if (action.type === "select") await selectArchivedWallpaper(action.id);
        await updateSettings({ bingWallpaperEnabled: enabled });
      }
      await queryClient.invalidateQueries({ queryKey: ARCHIVE_KEY });
    },
  });
  const imageFailed = useCallback(() => setFailedImage(wallpaper?.url ?? null), [wallpaper?.url]);
  const imageLoaded = useCallback(() => setFailedImage(null), []);
  const { refetch } = query;
  const { reset } = selection;
  const refresh = useCallback(() => {
    reset();
    setImageAttempt((attempt) => attempt + 1);
    void refetch();
  }, [refetch, reset]);
  const imageError =
    wallpaper && failedImage === wallpaper.url ? t("settings.appearance.bing.imageFailed") : null;
  return {
    enabled: settings.bingWallpaperEnabled,
    wallpaper,
    imageUrl: archived ? (image.data ?? null) : (wallpaper?.url ?? null),
    entries,
    selectedId,
    currentId: archived?.id ?? null,
    latestId,
    selectArchive: (id: string) => selection.mutate({ type: "select", id }),
    resumeDaily: () => selection.mutate({ type: "select", id: null }),
    deleteArchive: (id: string) => selection.mutate({ type: "delete", id }),
    available: Boolean(client),
    imageAttempt,
    selecting: selection.isPending,
    busy: selection.isPending || query.isFetching,
    error:
      [selection.error, archive.error, image.error, query.error].find(Boolean)?.message ??
      imageError,
    setEnabled: (enabled: boolean) => selection.mutate({ type: "enable", enabled }),
    refresh,
    imageFailed,
    imageLoaded,
  };
}

export const BingWallpaperContext = createContext<ReturnType<
  typeof useBingWallpaperController
> | null>(null);

export function useBingWallpaper() {
  const wallpaper = useContext(BingWallpaperContext);
  if (!wallpaper) throw new Error("useBingWallpaper requires AppearanceProvider");
  return wallpaper;
}
