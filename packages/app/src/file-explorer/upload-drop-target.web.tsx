import { useCallback, useState, type DragEvent, type CSSProperties } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import type { UploadDropTargetProps } from "./upload-drop-target";

const containerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

function targetDirectory(event: DragEvent<HTMLDivElement>): string {
  if (!(event.target instanceof Element)) return ".";
  return (
    event.target.closest("[data-upload-directory]")?.getAttribute("data-upload-directory") ?? "."
  );
}

export function UploadDropTarget({ children, disabled, onDrop, onReject }: UploadDropTargetProps) {
  const { t } = useTranslation();
  const [directory, setDirectory] = useState<string | null>(null);

  const dragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      if (!disabled) setDirectory(targetDirectory(event));
    },
    [disabled],
  );

  const drop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDirectory(null);
      if (disabled) return;
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
    [disabled, onDrop, onReject, t],
  );

  const dragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const isOutside =
      !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget);
    if (isOutside) setDirectory(null);
  }, []);

  return (
    <div style={containerStyle} onDragOver={dragOver} onDrop={drop} onDragLeave={dragLeave}>
      {children}
      {directory !== null && !disabled ? (
        <View pointerEvents="none" style={styles.destination}>
          <Text style={styles.label}>
            {t("workspace.fileExplorer.upload.destination", { directory })}
          </Text>
        </View>
      ) : null}
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  destination: { padding: theme.spacing[2], backgroundColor: theme.colors.surface2 },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
