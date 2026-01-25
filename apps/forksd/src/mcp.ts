/**
 * MCP server endpoint(s) for forksd.
 * Uses @modelcontextprotocol/sdk. Connect to stdio, SSE, or Streamable HTTP
 * when mounting. See: https://modelcontextprotocol.io/docs/develop/build-server
 */

import { Server } from "@modelcontextprotocol/sdk/server";

export function createMcpServer(): Server {
  return new Server(
    { name: "forksd", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
}
