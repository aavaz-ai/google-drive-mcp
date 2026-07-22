import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { validateManagedConnectorBearer } from './managedAuth.js';
import { GOOGLE_DRIVE_MCP_PACKAGE_NAME, GOOGLE_DRIVE_MCP_VERSION } from './managedContract.js';
import { GoogleDriveMcpError, toToolError } from './managedErrors.js';
import { GoogleDriveClient, type FetchLike, type Sleep } from './managedWorkspace.js';
import { handleTool, toolDefinitions } from './tools/managed.js';

export interface ManagedMcpServerOptions {
  bearer: string;
  fetch?: FetchLike;
  sleep?: Sleep;
}

/** Build the only MCP server reachable from the Enterpret package binary. */
export function createManagedMcpServer(options: ManagedMcpServerOptions): Server {
  const client = new GoogleDriveClient(validateManagedConnectorBearer(options.bearer), {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const server = new Server(
    { name: GOOGLE_DRIVE_MCP_PACKAGE_NAME, version: GOOGLE_DRIVE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.onerror = () => {
    console.error('@enterpret/google-drive-mcp: sanitized MCP protocol error');
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await handleTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      client,
    );
    return result ?? toToolError(new GoogleDriveMcpError('INVALID_INPUT'));
  });
  return server;
}
