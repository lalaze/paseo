import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { FileUploadStore } from "./index.js";

const tempDirs: string[] = [];

describe("file uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-upload"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("publishes workspace uploads only after completion, preserving Unicode names and existing files", async () => {
    const paseoHome = makePaseoHome();
    const cwd = makePaseoHome();
    mkdirSync(join(cwd, "nested"));
    const uploads = new FileUploadStore({ paseoHome });
    const request = {
      type: "file.upload.request" as const,
      fileName: "笔记.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "workspace-upload",
      destination: { cwd, directory: "nested" },
    };
    const target = join(cwd, "nested", request.fileName);
    uploads.beginUpload(request);
    await uploads.receiveFrame(uploadBegins(request.requestId));
    await uploads.receiveFrame(uploadChunk(request.requestId, "hello"));
    expect(existsSync(target)).toBe(false);
    const response = await uploads.receiveFrame(uploadEnds(request.requestId));
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.file?.path).toBe(target);
    expect(response?.payload.file?.fileName).toBe("笔记.txt");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(join(paseoHome, "uploads"))).toEqual([]);

    uploads.beginUpload(request);
    await uploads.receiveFrame(uploadBegins(request.requestId));
    await uploads.receiveFrame(uploadChunk(request.requestId, "other"));
    const collision = await uploads.receiveFrame(uploadEnds(request.requestId));
    expect(collision?.payload.error).toContain("EEXIST");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(join(cwd, "nested"))).toEqual(["笔记.txt"]);
    expect(readdirSync(join(paseoHome, "uploads"))).toEqual([]);
  });

  it("rejects traversal, symlink escapes, invalid names and oversized workspace uploads", async () => {
    const paseoHome = makePaseoHome();
    const cwd = makePaseoHome();
    const outside = makePaseoHome();
    symlinkSync(outside, join(cwd, "escape"), "junction");
    const uploads = new FileUploadStore({ paseoHome });
    const inputs = [
      { directory: "../outside", fileName: "file.txt", size: 0 },
      { directory: "escape", fileName: "file.txt", size: 0 },
      { directory: ".", fileName: "../file.txt", size: 0 },
      { directory: ".", fileName: "file.txt", size: 100 * 1024 * 1024 + 1 },
    ];
    for (const [index, input] of inputs.entries()) {
      const requestId = `invalid-${index}`;
      uploads.beginUpload({
        type: "file.upload.request",
        mimeType: "text/plain",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        requestId,
        fileName: input.fileName,
        size: input.size,
        destination: { cwd, directory: input.directory },
      });
      const response = await uploads.receiveFrame(uploadBegins(requestId));
      expect(response?.payload.file).toBeNull();
      expect(response?.payload.error).toEqual(expect.any(String));
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(cwd)).toEqual(["escape"]);
  });

  it("does not follow a destination file symlink or publish incomplete uploads", async () => {
    const paseoHome = makePaseoHome();
    const cwd = makePaseoHome();
    const outside = makePaseoHome();
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(join(outside, "keep.txt"), join(cwd, "file.txt"));
    const uploads = new FileUploadStore({ paseoHome });
    const request = {
      type: "file.upload.request" as const,
      fileName: "file.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "symlink-file",
      destination: { cwd, directory: "." },
    };
    uploads.beginUpload(request);
    await uploads.receiveFrame(uploadBegins(request.requestId));
    await uploads.receiveFrame(uploadChunk(request.requestId, "hello"));
    expect((await uploads.receiveFrame(uploadEnds(request.requestId)))?.payload.error).toContain(
      "EEXIST",
    );
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");

    uploads.beginUpload({ ...request, fileName: "partial.txt" });
    await uploads.receiveFrame(uploadBegins(request.requestId));
    await uploads.receiveFrame(uploadChunk(request.requestId, "hi"));
    expect((await uploads.receiveFrame(uploadEnds(request.requestId)))?.payload.error).toContain(
      "size mismatch",
    );
    expect(existsSync(join(cwd, "partial.txt"))).toBe(false);
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    const uploadDir = dirname(path);
    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.payload.error).toBeNull();
    expect(readFileSync(uploadedPath(paseoHome, "notes.txt"), "utf8")).toBe("hello world");
  });

  it("replaces duplicate upload starts without letting the old stale timeout evict the replacement", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "old.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "old"))).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(25);
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "new.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await vi.advanceTimersByTimeAsync(30);

    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "new"))).resolves.toBeNull();
    const path = uploadedPath(paseoHome, "new.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-duplicate"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-duplicate",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "new.txt",
          mimeType: "text/plain",
          size: 3,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("keeps an active upload alive beyond the initial stale timeout", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-slow-active",
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploads.receiveFrame(uploadBegins("req-slow-active"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(uploads.receiveFrame(uploadChunk("req-slow-active", "hello"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(
      uploads.receiveFrame(uploadChunk("req-slow-active", " world")),
    ).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-slow-active"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-slow-active",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });
});

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload: new TextEncoder().encode(text),
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}

function uploadedPath(paseoHome: string, fileName: string): string {
  const root = join(paseoHome, "uploads");
  const file = readdirSync(root)
    .map((id) => join(root, id, fileName))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`Upload file ${fileName} is missing`);
  return file;
}
