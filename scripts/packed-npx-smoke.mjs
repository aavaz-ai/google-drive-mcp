#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball) throw new Error("usage: node scripts/packed-npx-smoke.mjs <package.tgz>");

const expectedTools = [
  "ensure_workspace",
  "create_folder",
  "create_text_file",
  "create_google_doc",
  "create_google_sheet",
  "create_google_presentation",
  "share_item",
  "list_authorized_items",
  "search_authorized_items",
  "list_workspace_items",
  "search_workspace_items",
  "get_item_metadata",
  "read_text_file",
  "read_google_doc",
  "read_google_sheet",
  "read_google_presentation",
  "replace_text_file",
  "update_google_doc",
  "update_google_sheet",
  "update_google_presentation",
  "rename_item",
  "move_item",
  "copy_item",
  "trash_item",
  "restore_item",
  "list_item_permissions",
  "remove_item_permission",
];
const transport = new StdioClientTransport({
  command: "npx",
  args: ["--yes", "--package", resolve(tarball), "google-drive-mcp"],
  env: { ...process.env, GOOGLE_DRIVE_OAUTH_BEARER: "PACKED_ARTIFACT_DISCOVERY_ONLY" },
  stderr: "pipe",
});
const client = new Client({ name: "google-drive-packed-npx-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const actualTools = tools.map((tool) => tool.name);
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`unexpected tool surface: ${JSON.stringify(actualTools)}`);
  }
  const rejectedCall = await client.callTool({ name: "delete_item", arguments: {} });
  if (rejectedCall.isError !== true) {
    throw new Error("excluded permanent-delete tool was callable");
  }
  process.stdout.write(
    `packed npx smoke passed: ${actualTools.length} exact tools and excluded call rejected\n`,
  );
} finally {
  await client.close();
}
