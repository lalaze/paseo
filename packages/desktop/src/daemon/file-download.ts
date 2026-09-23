import path from "node:path";
import type { DownloadItem, WebContents } from "electron";
import { z } from "zod";
import {
  createSshProxy,
  LOCAL_TRANSPORT_SETUP_TIMEOUT_MS,
  parseTransportTarget,
} from "./local-transport.js";

const DownloadInputSchema = z.object({
  downloadId: z.string().min(1).max(128),
  token: z.string().min(1),
  fileName: z.string().min(1),
  target: z.unknown(),
});

interface NativeDownload
  extends
    Pick<
      DownloadItem,
      "getURL" | "getReceivedBytes" | "getTotalBytes" | "setSaveDialogOptions" | "cancel"
    >,
    Pick<NodeJS.EventEmitter, "on" | "once" | "removeListener"> {}

interface DownloadOwner
  extends
    Pick<WebContents, "downloadURL" | "send" | "isDestroyed">,
    Pick<NodeJS.EventEmitter, "once" | "removeListener"> {
  session: Pick<NodeJS.EventEmitter, "on" | "removeListener">;
}

interface SshDownloadInput {
  owner: DownloadOwner;
  downloadsDirectory: string;
  input: unknown;
}

export async function downloadSshFile(
  { owner, downloadsDirectory, input }: SshDownloadInput,
  openTunnel = createSshProxy,
): Promise<"completed" | "cancelled"> {
  const parsed = DownloadInputSchema.parse(input);
  const target = parseTransportTarget(parsed.target);
  if (target.transportType !== "ssh") {
    throw new Error("SSH downloads require an SSH transport target.");
  }
  const endpoint = await openTunnel(target);
  try {
    if (owner.isDestroyed()) return "cancelled";
    const url = new URL("/api/files/download", endpoint.url.replace(/^ws:/u, "http:"));
    url.searchParams.set("token", parsed.token);
    const downloadUrl = url.toString();
    const safeName = parsed.fileName.replace(/[\\/:*?"<>|]+/gu, "_");

    return await new Promise<"completed" | "cancelled">((resolve, reject) => {
      let download: NativeDownload | null = null;
      let settled = false;
      const setupDeadline = setTimeout(() => {
        abort(new Error("SSH download timed out while connecting."));
      }, LOCAL_TRANSPORT_SETUP_TIMEOUT_MS);
      setupDeadline.unref();

      function finish(result: "completed" | "cancelled" | Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(setupDeadline);
        owner.session.removeListener("will-download", onDownload);
        owner.removeListener("destroyed", onDestroyed);
        download?.removeListener("updated", onUpdated);
        download?.removeListener("done", onDone);
        if (result instanceof Error) reject(result);
        else resolve(result);
      }

      function abort(result: "cancelled" | Error): void {
        finish(result);
        download?.cancel();
      }

      function interrupted(): Error {
        return new Error(endpoint.failureDetail() ?? "SSH file download was interrupted.");
      }

      function onDestroyed(): void {
        abort("cancelled");
      }

      function onUpdated(_event: unknown, state: "progressing" | "interrupted"): void {
        if (state === "interrupted") {
          // Tokens and SSH stdio tunnels are single-use; this transfer cannot resume.
          abort(interrupted());
          return;
        }
        if (download && !owner.isDestroyed()) {
          owner.send("paseo:event:file-download-progress", {
            downloadId: parsed.downloadId,
            bytesWritten: download.getReceivedBytes(),
            totalBytes: download.getTotalBytes(),
          });
        }
      }

      function onDone(_event: unknown, state: "completed" | "cancelled" | "interrupted"): void {
        finish(state === "interrupted" ? interrupted() : state);
      }

      function onDownload(_event: unknown, item: NativeDownload, source: DownloadOwner): void {
        if (source !== owner || item.getURL() !== downloadUrl) return;
        clearTimeout(setupDeadline);
        owner.session.removeListener("will-download", onDownload);
        download = item;
        item.setSaveDialogOptions({ defaultPath: path.join(downloadsDirectory, safeName) });
        item.on("updated", onUpdated);
        item.once("done", onDone);
      }

      owner.session.on("will-download", onDownload);
      owner.once("destroyed", onDestroyed);
      try {
        owner.downloadURL(downloadUrl);
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    endpoint.close();
  }
}
