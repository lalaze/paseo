import { test, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { downgradeNewerMcpProtocolVersion } from "./mcp-protocol-version.js";

function request(version: string): IncomingMessage {
  return {
    headers: { "mcp-protocol-version": version, "content-type": "application/json" },
    rawHeaders: ["Content-Type", "application/json", "MCP-Protocol-Version", version],
  } as unknown as IncomingMessage;
}

test("a newer MCP protocol version is served as the latest supported one", () => {
  const req = request("2026-07-28");
  downgradeNewerMcpProtocolVersion(req);
  expect(req.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
  expect(req.rawHeaders).toEqual([
    "Content-Type",
    "application/json",
    "MCP-Protocol-Version",
    LATEST_PROTOCOL_VERSION,
  ]);
});

test("supported, older and malformed versions are left for the SDK to judge", () => {
  for (const version of ["2025-06-18", "2020-01-01", "latest"]) {
    const req = request(version);
    downgradeNewerMcpProtocolVersion(req);
    expect(req.headers["mcp-protocol-version"]).toBe(version);
    expect(req.rawHeaders[3]).toBe(version);
  }
});
