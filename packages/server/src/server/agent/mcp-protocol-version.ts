import type { IncomingMessage } from "node:http";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

const HEADER = "mcp-protocol-version";

/**
 * Some agent MCP clients (antigravity-hub) keep sending a newer MCP-Protocol-Version header than
 * the one negotiated at initialize. The SDK rejects every stateless request carrying an unknown
 * version, which silently drops Paseo tools from the agent. Tool listing and calls are unchanged
 * across these versions, so a newer version is served as the latest one this SDK supports.
 * Older or malformed versions still reach the SDK and are rejected there.
 */
export function downgradeNewerMcpProtocolVersion(req: IncomingMessage): void {
  const version = req.headers[HEADER];
  if (
    typeof version !== "string" ||
    SUPPORTED_PROTOCOL_VERSIONS.includes(version) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(version) ||
    version < LATEST_PROTOCOL_VERSION
  )
    return;
  req.headers[HEADER] = LATEST_PROTOCOL_VERSION;
  // The SDK's Node adapter builds its Request from rawHeaders, not headers.
  for (let index = 0; index < req.rawHeaders.length; index += 2)
    if (req.rawHeaders[index].toLowerCase() === HEADER)
      req.rawHeaders[index + 1] = LATEST_PROTOCOL_VERSION;
}
