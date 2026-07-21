#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { readManagedConnectorBearer } from './managedAuth.js';
import { GOOGLE_DRIVE_MCP_VERSION } from './managedContract.js';
import { createManagedMcpServer } from './managedServer.js';

function showHelp(): void {
  process.stdout.write(`Enterpret Google Drive MCP Server v${GOOGLE_DRIVE_MCP_VERSION}\n\n`);
  process.stdout.write('Usage:\n');
  process.stdout.write('  google-drive-mcp [start]\n');
  process.stdout.write('  google-drive-mcp --help\n');
  process.stdout.write('  google-drive-mcp --version\n\n');
  process.stdout.write('The server is stdio-only and requires GOOGLE_DRIVE_OAUTH_BEARER.\n');
}

async function startManagedStdio(): Promise<void> {
  const bearer = readManagedConnectorBearer();
  const server = createManagedMcpServer({ bearer });
  console.error('@enterpret/google-drive-mcp: starting stdio server');
  await server.connect(new StdioServerTransport());
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === 'start')) {
    await startManagedStdio();
    return;
  }
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0] ?? '')) {
    showHelp();
    return;
  }
  if (args.length === 1 && ['--version', '-v', 'version'].includes(args[0] ?? '')) {
    process.stdout.write(`${GOOGLE_DRIVE_MCP_VERSION}\n`);
    return;
  }
  throw new Error('unsupported managed CLI option');
}

main(process.argv.slice(2)).catch(() => {
  console.error('@enterpret/google-drive-mcp: startup failed safely');
  process.exitCode = 1;
});
