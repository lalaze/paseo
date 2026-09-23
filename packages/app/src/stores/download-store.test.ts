// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostProfile } from "@/types/host-connection";
import { useDownloadStore } from "./download-store";

const desktop = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

// File-system and Electron APIs are platform boundaries; the download store is real.
vi.mock("expo-file-system", () => ({ File: vi.fn(), Paths: {} }));
vi.mock("expo-file-system/legacy", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("@/constants/platform", () => ({ isWeb: true, getIsElectron: () => true }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ invoke: desktop.invoke, events: { on: desktop.listen } }),
}));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));

const sshHost: HostProfile = {
  serverId: "remote-host",
  label: "Remote host",
  appearance: defaultHostAppearance(),
  lifecycle: {},
  connections: [
    { id: "ssh", type: "remoteSsh", host: "build-box", sshPort: 2222, daemonPort: 7777 },
  ],
  preferredConnectionId: "ssh",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};

function downloadParams(daemonProfile = sshHost) {
  return {
    serverId: sshHost.serverId,
    scopeId: "workspace",
    fileName: "audio.mp3",
    path: "music/audio.mp3",
    daemonProfile,
    activeConnectionId: "ssh",
    requestFileDownloadToken: async () => ({
      token: "download-token",
      fileName: "audio.mp3",
      mimeType: "audio/mpeg",
      error: null,
    }),
  };
}

describe("workspace downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
    desktop.listen.mockResolvedValue(desktop.unlisten);
    desktop.invoke.mockResolvedValue("completed");
  });

  it("downloads from an SSH-only host without requiring a direct TCP address", async () => {
    await useDownloadStore.getState().startDownload(downloadParams());

    expect([...useDownloadStore.getState().downloads.values()]).toEqual([
      expect.objectContaining({ fileName: "audio.mp3", status: "complete" }),
    ]);
    expect(desktop.invoke).toHaveBeenCalledWith("download_ssh_file", {
      downloadId: expect.any(String),
      target: { transportType: "ssh", host: "build-box", sshPort: 2222, daemonPort: 7777 },
      token: "download-token",
      fileName: "audio.mp3",
    });
    expect(desktop.unlisten).toHaveBeenCalledOnce();
  });

  it("uses the active SSH connection even when the host also has a direct TCP address", async () => {
    await useDownloadStore.getState().startDownload(
      downloadParams({
        ...sshHost,
        connections: [
          { id: "tcp", type: "directTcp", endpoint: "unreachable.example:6767" },
          ...sshHost.connections,
        ],
      }),
    );

    expect(desktop.invoke).toHaveBeenCalledWith("download_ssh_file", expect.any(Object));
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("complete");
  });

  it("shows progress and waits for the native download to finish before reporting success", async () => {
    let onProgress: (payload: unknown) => void = () => {};
    desktop.listen.mockImplementation(async (_event, listener) => {
      onProgress = listener;
      return desktop.unlisten;
    });
    let complete = (_result: string) => {};
    const completion = new Promise<string>((resolve) => {
      complete = resolve;
    });
    desktop.invoke.mockReturnValue(completion);
    const downloading = useDownloadStore.getState().startDownload(downloadParams());
    await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledOnce());
    const downloadId = useDownloadStore.getState().activeDownloadId;

    onProgress({ downloadId: "other-download", bytesWritten: 80, totalBytes: 100 });
    expect([...useDownloadStore.getState().downloads.values()][0]?.progress).toBeUndefined();
    onProgress({ downloadId, bytesWritten: 40, totalBytes: 100 });
    expect([...useDownloadStore.getState().downloads.values()][0]).toMatchObject({
      status: "downloading",
      progress: { bytesWritten: 40, totalBytes: 100, percent: 0.4 },
    });

    complete("completed");
    await downloading;
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("complete");
    expect(desktop.unlisten).toHaveBeenCalledOnce();
  });

  it("reports cancellation and releases the progress listener", async () => {
    desktop.invoke.mockResolvedValue("cancelled");
    await useDownloadStore.getState().startDownload(downloadParams());

    expect([...useDownloadStore.getState().downloads.values()][0]).toMatchObject({
      status: "error",
      message: "downloads.cancelled",
    });
    expect(desktop.unlisten).toHaveBeenCalledOnce();
  });

  it("reports an SSH failure and releases the progress listener", async () => {
    desktop.invoke.mockRejectedValue(new Error("SSH file download was interrupted."));
    await useDownloadStore.getState().startDownload(downloadParams());

    expect([...useDownloadStore.getState().downloads.values()][0]).toMatchObject({
      status: "error",
      message: "SSH file download was interrupted.",
    });
    expect(desktop.unlisten).toHaveBeenCalledOnce();
  });

  it("keeps direct TCP downloads on their existing HTTP path", async () => {
    let clickedUrl: string | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedUrl = this.href;
      });
    const params = downloadParams({
      ...sshHost,
      connections: [{ id: "tcp", type: "directTcp", endpoint: "download.example:6767" }],
    });
    await useDownloadStore.getState().startDownload({ ...params, activeConnectionId: "tcp" });

    expect(desktop.invoke).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
    expect(clickedUrl).toBe("http://download.example:6767/api/files/download?token=download-token");
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("complete");
    click.mockRestore();
  });
});
