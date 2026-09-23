import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, X, XCircle } from "lucide-react-native";
import { useDownloadStore, formatSpeed, formatEta, type Download } from "@/stores/download-store";
import { ICON_SIZE } from "@/styles/theme";

const AUTO_DISMISS_DELAY = 3000;
const DOWNLOAD_TOAST_WIDTH = 344;
const DownloadSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const CompleteIcon = withUnistyles(Check, (theme) => ({ color: theme.colors.statusSuccess }));
const ErrorIcon = withUnistyles(XCircle, (theme) => ({ color: theme.colors.statusDanger }));

function getDownloadStatusText(download: Download, t: TFunction): string {
  if (download.status === "downloading") {
    if (download.progress) {
      return `${Math.round(download.progress.percent * 100)}% · ${formatSpeed(download.progress.speed)} · ${formatEta(download.progress.eta)}`;
    }
    return t("common.states.starting");
  }
  if (download.status === "complete") return t("common.states.downloadComplete");
  return download.message ?? t("common.states.downloadFailed");
}

export function DownloadToast() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const downloads = useDownloadStore((state) => state.downloads);
  const activeDownloadId = useDownloadStore((state) => state.activeDownloadId);
  const dismissDownload = useDownloadStore((state) => state.dismissDownload);

  const activeDownload = activeDownloadId ? downloads.get(activeDownloadId) : null;
  const downloadId = activeDownload?.id;
  const downloadStatus = activeDownload?.status;

  useEffect(() => {
    if (!downloadId || downloadStatus !== "complete") return;
    const timeout = setTimeout(() => dismissDownload(downloadId), AUTO_DISMISS_DELAY);
    return () => clearTimeout(timeout);
  }, [downloadId, downloadStatus, dismissDownload]);

  const handleDismiss = useCallback(() => {
    if (activeDownload) {
      dismissDownload(activeDownload.id);
    }
  }, [activeDownload, dismissDownload]);

  if (!activeDownload) {
    return null;
  }

  return (
    <View
      style={styles.container(insets.bottom, insets.left, insets.right)}
      pointerEvents="box-none"
    >
      <View style={styles.toast} testID="download-toast">
        <View style={styles.row}>
          <View style={styles.icon}>
            {activeDownload.status === "downloading" ? <DownloadSpinner size="small" /> : null}
            {activeDownload.status === "complete" ? <CompleteIcon size={ICON_SIZE.md} /> : null}
            {activeDownload.status === "error" ? <ErrorIcon size={ICON_SIZE.md} /> : null}
          </View>
          <View style={styles.textContainer} accessibilityLiveRegion="polite">
            <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
              {activeDownload.fileName}
            </Text>
            <Text style={styles.status}>{getDownloadStatusText(activeDownload, t)}</Text>
          </View>
          {activeDownload.status !== "downloading" && (
            <Button
              variant="ghost"
              size="xs"
              leftIcon={X}
              onPress={handleDismiss}
              accessibilityLabel={t("common.actions.dismiss")}
              style={styles.dismiss}
            />
          )}
        </View>
        {activeDownload.status === "downloading" && activeDownload.progress && (
          <DownloadProgressBar percent={activeDownload.progress.percent} />
        )}
      </View>
    </View>
  );
}

function DownloadProgressBar({ percent }: { percent: number }) {
  const progress = Math.round(Math.min(1, Math.max(0, percent)) * 100);
  const width: `${number}%` = `${progress}%`;
  const fillStyle = useMemo(() => [styles.progressFill, { width }], [width]);
  const accessibilityValue = useMemo(() => ({ min: 0, max: 100, now: progress }), [progress]);
  return (
    <View
      style={styles.progressBar}
      accessibilityRole="progressbar"
      accessibilityValue={accessibilityValue}
    >
      <View style={fillStyle} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: (bottom: number, left: number, right: number) => ({
    position: "absolute",
    bottom: theme.spacing[4] + bottom,
    left: theme.spacing[4] + left,
    right: theme.spacing[4] + right,
    alignItems: "flex-end",
    zIndex: 1000,
  }),
  toast: {
    width: "100%",
    maxWidth: DOWNLOAD_TOAST_WIDTH,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  icon: {
    width: theme.spacing[8],
    height: theme.spacing[8],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  textContainer: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  progressBar: {
    height: 3,
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[3],
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.full,
  },
  dismiss: {
    width: theme.spacing[8],
    paddingHorizontal: 0,
    flexShrink: 0,
  },
}));
