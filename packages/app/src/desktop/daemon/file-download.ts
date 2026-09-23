import { z } from "zod";
import { getDesktopHost } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { RemoteSshHostConnection } from "@/types/host-connection";

const DownloadProgressSchema = z.object({
  downloadId: z.string(),
  bytesWritten: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
});
const DownloadResultSchema = z.enum(["completed", "cancelled"]);

interface SshFileDownloadInput {
  downloadId: string;
  connection: RemoteSshHostConnection;
  token: string;
  fileName: string;
  onProgress: (bytesWritten: number, totalBytes: number) => void;
}

export async function downloadSshFile(input: SshFileDownloadInput) {
  const listen = getDesktopHost()?.events?.on;
  if (!listen) {
    throw new Error("Desktop download events are unavailable.");
  }
  const unlisten = await listen("file-download-progress", (payload) => {
    const progress = DownloadProgressSchema.safeParse(payload);
    if (progress.success && progress.data.downloadId === input.downloadId) {
      input.onProgress(progress.data.bytesWritten, progress.data.totalBytes);
    }
  });
  try {
    const result = await invokeDesktopCommand<unknown>("download_ssh_file", {
      downloadId: input.downloadId,
      target: {
        transportType: "ssh",
        host: input.connection.host,
        sshPort: input.connection.sshPort,
        daemonPort: input.connection.daemonPort,
      },
      token: input.token,
      fileName: input.fileName,
    });
    return DownloadResultSchema.parse(result);
  } finally {
    unlisten();
  }
}
