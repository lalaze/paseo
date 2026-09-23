import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadSshFile } from "./file-download";
import { LOCAL_TRANSPORT_SETUP_TIMEOUT_MS } from "./local-transport";

const input = {
  downloadId: "download-1",
  target: { transportType: "ssh", host: "build-box", sshPort: 2222, daemonPort: 7777 },
  token: "one-use-token",
  fileName: "audio.mp3",
};

function createHarness() {
  const owner = Object.assign(new EventEmitter(), {
    session: new EventEmitter(),
    downloadURL: vi.fn<(url: string) => void>(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  });
  const endpoint = {
    url: "ws://127.0.0.1:12345/ws",
    close: vi.fn(),
    failureDetail: vi.fn<() => string | null>(() => null),
  };
  const openTunnel = vi.fn(async () => endpoint);
  const item = Object.assign(new EventEmitter(), {
    getURL: () => "http://127.0.0.1:12345/api/files/download?token=one-use-token",
    getReceivedBytes: () => 256,
    getTotalBytes: () => 1024,
    setSaveDialogOptions: vi.fn(),
    cancel: vi.fn(),
  });
  const start = () =>
    downloadSshFile({ owner, downloadsDirectory: "/downloads", input }, openTunnel);
  const begin = () => owner.session.emit("will-download", {}, item, owner);
  return { owner, endpoint, openTunnel, item, start, begin };
}

afterEach(() => vi.useRealTimers());

describe("SSH file downloads", () => {
  it("forwards the token over SSH, reports progress, and completes only after the file is saved", async () => {
    const { owner, endpoint, openTunnel, item, start, begin } = createHarness();
    const result = start();
    await Promise.resolve();
    expect(openTunnel).toHaveBeenCalledWith(input.target);
    expect(owner.downloadURL).toHaveBeenCalledWith(item.getURL());
    expect(endpoint.close).not.toHaveBeenCalled();

    begin();
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      defaultPath: path.join("/downloads", "audio.mp3"),
    });
    item.emit("updated", {}, "progressing");
    expect(owner.send).toHaveBeenCalledWith("paseo:event:file-download-progress", {
      downloadId: "download-1",
      bytesWritten: 256,
      totalBytes: 1024,
    });
    expect(endpoint.close).not.toHaveBeenCalled();

    item.emit("done", {}, "completed");
    await expect(result).resolves.toBe("completed");
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(owner.session.listenerCount("will-download")).toBe(0);
    expect(owner.listenerCount("destroyed")).toBe(0);
    expect(item.listenerCount("updated")).toBe(0);
    expect(item.listenerCount("done")).toBe(0);
  });

  it("ignores downloads started by another window or for another URL", async () => {
    const { owner, item, start, begin } = createHarness();
    const result = start();
    await Promise.resolve();
    owner.session.emit("will-download", {}, item, createHarness().owner);
    owner.session.emit(
      "will-download",
      {},
      { ...item, getURL: () => "https://example.com" },
      owner,
    );
    expect(item.setSaveDialogOptions).not.toHaveBeenCalled();

    begin();
    item.emit("done", {}, "completed");
    await expect(result).resolves.toBe("completed");
  });

  it("closes the tunnel when the save dialog is cancelled", async () => {
    const { endpoint, item, start, begin } = createHarness();
    const result = start();
    await Promise.resolve();
    begin();
    item.emit("done", {}, "cancelled");
    await expect(result).resolves.toBe("cancelled");
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("aborts an interrupted transfer instead of attempting to reuse its token", async () => {
    const { endpoint, item, start, begin } = createHarness();
    const result = start();
    await Promise.resolve();
    begin();
    endpoint.failureDetail.mockReturnValue("ssh: connection reset");
    item.emit("updated", {}, "interrupted");
    await expect(result).rejects.toThrow("ssh: connection reset");
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("reports a terminal download failure", async () => {
    const { endpoint, item, start, begin } = createHarness();
    const result = start();
    await Promise.resolve();
    begin();
    item.emit("done", {}, "interrupted");
    await expect(result).rejects.toThrow("SSH file download was interrupted.");
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("releases a stalled setup", async () => {
    vi.useFakeTimers();
    const { owner, endpoint, start } = createHarness();
    const result = start();
    const assertion = expect(result).rejects.toThrow("SSH download timed out while connecting.");
    await vi.advanceTimersByTimeAsync(LOCAL_TRANSPORT_SETUP_TIMEOUT_MS);
    await assertion;
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(owner.session.listenerCount("will-download")).toBe(0);
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("closes the tunnel if the window disappears while the tunnel is opening", async () => {
    const { owner, endpoint, start } = createHarness();
    const result = start();
    owner.isDestroyed.mockReturnValue(true);
    await expect(result).resolves.toBe("cancelled");
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(owner.downloadURL).not.toHaveBeenCalled();
  });

  it("cancels the download and closes the tunnel when its window closes", async () => {
    const { owner, endpoint, item, start, begin } = createHarness();
    const result = start();
    await Promise.resolve();
    begin();
    owner.emit("destroyed");
    await expect(result).resolves.toBe("cancelled");
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });

  it("validates the SSH target before opening a tunnel", async () => {
    const { owner, openTunnel } = createHarness();
    await expect(
      downloadSshFile(
        {
          owner,
          downloadsDirectory: "/downloads",
          input: { ...input, target: { transportType: "ssh", host: "-oProxyCommand=bad" } },
        },
        openTunnel,
      ),
    ).rejects.toThrow("SSH host is invalid");
    expect(openTunnel).not.toHaveBeenCalled();
  });
});
