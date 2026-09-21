import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useFilePicker } from "@/hooks/use-file-picker";
import type { SelectedFile } from "@/attachments/selected-file";

type UploadState =
  | { status: "idle" }
  | { status: "pending"; message: string }
  | { status: "finished"; message: string; errors: string[] };

interface UseUploadOptions {
  serverId: string;
  workspaceRoot: string;
  onUploaded(directory: string): Promise<unknown>;
}

class UploadError extends Error {}

export function useUpload({ serverId, workspaceRoot, onUploaded }: UseUploadOptions) {
  const { t } = useTranslation();
  const { pickFiles } = useFilePicker();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(workspaceFileUpload): added in v0.9.0, remove after 2027-03-21 once daemon floor >= v0.9.0.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileUpload === true,
  );
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const active = useRef(false);

  const upload = useCallback(
    async (getFiles: () => Promise<SelectedFile[] | null>, directory: string) => {
      if (active.current) return;
      active.current = true;
      setState({ status: "pending", message: t("workspace.fileExplorer.upload.preparing") });
      let completed = 0;
      const errors: string[] = [];
      try {
        if (!supported) throw new UploadError(t("workspace.fileExplorer.upload.updateHost"));
        if (!client) throw new UploadError(t("workspace.terminal.hostDisconnected"));
        const files = await getFiles();
        if (!files?.length) {
          setState({ status: "idle" });
          return;
        }
        for (const file of files) {
          const reportProgress = (percent: number) =>
            setState({
              status: "pending",
              message: t("workspace.fileExplorer.upload.progress", {
                name: file.fileName,
                percent,
              }),
            });
          try {
            reportProgress(0);
            const bytes = await file.readBytes();
            if (bytes.byteLength > 100 * 1024 * 1024) {
              throw new UploadError(t("workspace.fileExplorer.upload.tooLarge"));
            }
            const response = await client.uploadFile({
              fileName: file.fileName,
              mimeType: file.mimeType,
              bytes,
              destination: { cwd: workspaceRoot, directory },
              onProgress: (sent) =>
                reportProgress(Math.floor((sent / Math.max(bytes.byteLength, 1)) * 100)),
            });
            if (response.error) throw new UploadError(response.error);
            completed++;
          } catch (error) {
            errors.push(
              `${file.fileName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (completed) await onUploaded(directory);
        setState({
          status: "finished",
          message: t("workspace.fileExplorer.upload.complete", { completed, total: files.length }),
          errors,
        });
      } catch (error) {
        setState({
          status: "finished",
          message: "",
          errors: [error instanceof Error ? error.message : String(error)],
        });
      } finally {
        active.current = false;
      }
    },
    [client, onUploaded, supported, t, workspaceRoot],
  );

  return {
    state,
    supported,
    busy: state.status === "pending",
    pick: (directory: string) => void upload(pickFiles, directory),
    drop: (files: SelectedFile[], directory: string) => void upload(async () => files, directory),
    reject: (message: string) => setState({ status: "finished", message: "", errors: [message] }),
  };
}
