#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument } from "pdf-lib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const pdf = await PDFDocument.create();
pdf.addPage().drawText("Packed PDF extraction works");
const fixtures = {
  packed_pdf: { mime: "application/pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
  packed_rtf: { mime: "application/rtf", base64: Buffer.from("{\\rtf1\\ansi Packed RTF extraction works}").toString("base64") },
};
const preload = pathToFileURL(resolve(import.meta.dirname, "../tests/managed/fixtures/packed-document-fetch.mjs")).href;
const transport = new StdioClientTransport({
  command: "npx",
  args: ["--yes", "--package", resolve(tarball), "google-drive-mcp"],
  env: {
    ...process.env,
    GOOGLE_DRIVE_OAUTH_BEARER: "PACKED_ARTIFACT_DISCOVERY_ONLY",
    NODE_OPTIONS: `--import=${preload}`,
    DRIVE_PACKED_DOCUMENT_FIXTURES: JSON.stringify(fixtures),
  },
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
  for (const [id, expected] of [["packed_pdf", "Packed PDF extraction works"], ["packed_rtf", "Packed RTF extraction works"]]) {
    const result = await client.callTool({ name: "read_text_file", arguments: { item_id: id, offset: 0, limit: 2000 } });
    if (result.isError || result.structuredContent?.status !== "ok" || !result.structuredContent?.text?.includes(expected)) {
      throw new Error(`packed document extraction failed for ${id}`);
    }
  }
  // Validate the error envelope directly: SDK callTool applies the cached success-only
  // output schema even to isError responses after tools/list.
  const unauthorized = await client.request({ method: "tools/call", params: { name: "read_text_file", arguments: { item_id: "unselected", offset: 0, limit: 20 } } }, CallToolResultSchema);
  if (unauthorized.isError !== true || unauthorized.structuredContent?.error?.code !== "DRIVE_ITEM_NOT_AUTHORIZED") {
    throw new Error("packed document reader did not reject an unselected file");
  }
  process.stdout.write(
    `packed npx smoke passed: ${actualTools.length} exact tools, excluded call rejected, PDF/RTF content extracted, unselected file denied\n`,
  );
} finally {
  await client.close();
}
