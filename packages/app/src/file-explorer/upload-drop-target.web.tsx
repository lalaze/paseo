import { useCallback, useRef, useState, type DragEvent, type CSSProperties } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import { parentExplorerPath } from "@/utils/explorer-paths";
import type { ExplorerReorder } from "./tree";
import type { UploadDropTargetProps } from "./upload-drop-target";

const REORDER_MIME = "application/x-paseo-explorer-order";
const containerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
  display: "flex",
  flexDirection: "column",
};

type DropPreview =
  | { type: "upload"; directory: string }
  | { type: "reorder"; top: number; left: number; width: number }
  | null;

function targetDirectory(event: DragEvent<HTMLDivElement>): string {
  if (!(event.target instanceof Element)) return ".";
  return (
    event.target.closest("[data-upload-directory]")?.getAttribute("data-upload-directory") ?? "."
  );
}

function reorderTarget(event: DragEvent<HTMLDivElement>, source: string | null) {
  if (!source || !(event.target instanceof Element)) return null;
  const row = event.target.closest("[data-explorer-path]");
  const target = row?.getAttribute("data-explorer-path");
  if (!row || !target || target === source) return null;
  if (parentExplorerPath(source) !== parentExplorerPath(target)) return null;
  const bounds = row.getBoundingClientRect();
  const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  const reorder: ExplorerReorder = { source, target, position };
  return { reorder, bounds };
}

export function UploadDropTarget({
  children,
  disabled,
  unavailableReason,
  onDrop,
  onReject,
  onReorder,
}: UploadDropTargetProps) {
  const { t } = useTranslation();
  const source = useRef<string | null>(null);
  const [preview, setPreview] = useState<DropPreview>(null);

  const dragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    source.current =
      event.target.closest("[data-explorer-path]")?.getAttribute("data-explorer-path") ?? null;
    if (!source.current) return;
    // Keep the file attachment payload supplied by the inner file drag source.
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(REORDER_MIME, source.current);
  }, []);

  const dragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const isUpload = event.dataTransfer.types.includes("Files");
      const isReorder = event.dataTransfer.types.includes(REORDER_MIME);
      if (!isUpload && !isReorder) return;
      event.preventDefault();
      event.stopPropagation();
      if (isUpload) {
        event.dataTransfer.dropEffect = disabled || unavailableReason ? "none" : "copy";
        setPreview(disabled ? null : { type: "upload", directory: targetDirectory(event) });
        return;
      }
      const target = reorderTarget(event, source.current);
      event.dataTransfer.dropEffect = target ? "move" : "none";
      if (!target) {
        setPreview(null);
        return;
      }
      const container = event.currentTarget.getBoundingClientRect();
      const edge = target.reorder.position === "before" ? target.bounds.top : target.bounds.bottom;
      setPreview({
        type: "reorder",
        top: edge - container.top,
        left: target.bounds.left - container.left,
        width: target.bounds.width,
      });
    },
    [disabled, unavailableReason],
  );

  const drop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const isUpload = event.dataTransfer.types.includes("Files");
      const isReorder = event.dataTransfer.types.includes(REORDER_MIME);
      if (!isUpload && !isReorder) return;
      event.preventDefault();
      event.stopPropagation();
      setPreview(null);
      if (!isUpload) {
        const target = reorderTarget(event, source.current);
        source.current = null;
        if (target) onReorder(target.reorder);
        return;
      }
      if (disabled) return;
      if (unavailableReason) {
        onReject(unavailableReason);
        return;
      }
      const items = Array.from(event.dataTransfer.items);
      if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        onReject(t("workspace.fileExplorer.upload.foldersUnsupported"));
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.some((file) => file.size > 100 * 1024 * 1024)) {
        onReject(t("workspace.fileExplorer.upload.tooLarge"));
        return;
      }
      onDrop(
        files.map((file) => ({
          fileName: file.name,
          mimeType: file.type || getMimeTypeFromPath(file.name),
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        })),
        targetDirectory(event),
      );
    },
    [disabled, unavailableReason, onDrop, onReject, onReorder, t],
  );

  const dragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const isOutside =
      !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget);
    if (isOutside) setPreview(null);
  }, []);

  const dragEnd = useCallback(() => {
    source.current = null;
    setPreview(null);
  }, []);

  return (
    <div
      style={containerStyle}
      onDragStart={dragStart}
      onDragOverCapture={dragOver}
      onDragEnterCapture={dragOver}
      onDropCapture={drop}
      onDragLeave={dragLeave}
      onDragEnd={dragEnd}
    >
      {children}
      {preview?.type === "upload" ? (
        <View pointerEvents="none" style={styles.destination}>
          <Text style={styles.label}>
            {unavailableReason ??
              t("workspace.fileExplorer.upload.destination", { directory: preview.directory })}
          </Text>
        </View>
      ) : null}
      {preview?.type === "reorder" ? (
        <View
          pointerEvents="none"
          testID="files-reorder-indicator"
          style={[styles.insertion, { top: preview.top, left: preview.left, width: preview.width }]}
        />
      ) : null}
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  destination: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  insertion: { position: "absolute", height: 2, backgroundColor: theme.colors.foreground },
}));
