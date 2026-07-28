import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOOGLE_DRIVE_TOOL_ANNOTATIONS,
  GOOGLE_DRIVE_TOOL_NAMES,
} from "../../src/managedContract.js";
import type { FetchLike } from "../../src/managedWorkspace.js";
import { WORKSPACE_DESCRIPTION } from "../../src/managedWorkspace.js";
import { createManagedMcpServer } from "../../src/managedServer.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectedClient(fetcher: FetchLike): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createManagedMcpServer({ bearer: "test_bearer", fetch: fetcher, sleep: async () => undefined });
  const client = new Client({ name: "google-drive-mcp-tests", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("MCP surface", () => {
  it("discovers exactly the allowlisted tools, strict schemas, and exact annotations", async () => {
    const client = await connectedClient(async () => {
      throw new Error("discovery must not call Google");
    });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(GOOGLE_DRIVE_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.annotations).toEqual(
        GOOGLE_DRIVE_TOOL_ANNOTATIONS[tool.name as keyof typeof GOOGLE_DRIVE_TOOL_ANNOTATIONS],
      );
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema?.additionalProperties).toBe(false);
    }
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "raw_query",
        "generic_rest",
        "upload_file",
        "replace_file_content",
        "download_file",
        "export_google_file",
        "create_public_link",
        "transfer_ownership",
        "delete_item",
        "list_entire_drive",
        "list_authorized_folders",
      ]),
    );

    const sharing = tools.find((tool) => tool.name === "share_item");
    expect(sharing?.inputSchema.properties?.recipient_type).toMatchObject({ enum: ["user", "group"] });
    expect(sharing?.inputSchema.properties?.role).toMatchObject({ enum: ["reader", "commenter", "writer"] });
    expect(tools.find((tool) => tool.name === "read_google_doc")?.description).toContain("single-tab");
    expect(tools.find((tool) => tool.name === "update_google_doc")?.description).toContain("single-tab");
    expect(tools.find((tool) => tool.name === "list_authorized_items")?.inputSchema.properties?.type).toMatchObject({
      enum: ["file", "folder", "doc", "sheet", "slides", "blob"],
    });
    expect(tools.find((tool) => tool.name === "search_authorized_items")?.inputSchema.properties?.limit).toMatchObject({
      minimum: 1,
      maximum: 100,
    });
    expect(tools.find((tool) => tool.name === "search_authorized_items")?.inputSchema.properties).not.toHaveProperty("q");
    expect(tools.find((tool) => tool.name === "search_authorized_items")?.inputSchema.properties).not.toHaveProperty("raw_query");
    expect(tools.find((tool) => tool.name === "read_google_sheet")?.outputSchema?.properties?.values).toMatchObject({
      maxItems: 10_000,
      items: { maxItems: 10_000 },
    });
    const exactStatuses: Record<string, string> = {
      create_folder: "created",
      create_text_file: "created",
      create_google_doc: "created",
      create_google_sheet: "created",
      create_google_presentation: "created",
      share_item: "shared",
      get_item_metadata: "ok",
      replace_text_file: "updated",
      update_google_doc: "updated",
      update_google_sheet: "updated",
      update_google_presentation: "updated",
      rename_item: "renamed",
      move_item: "moved",
      copy_item: "copied",
      trash_item: "trashed",
      restore_item: "restored",
      remove_item_permission: "permission_removed",
    };
    for (const [toolName, status] of Object.entries(exactStatuses)) {
      expect(tools.find((tool) => tool.name === toolName)?.outputSchema?.properties?.status).toMatchObject({
        const: status,
      });
    }
  });

  it("initializes, lists, and calls a tool over MCP without exposing the bearer", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const workspace = {
      id: "workspace_id",
      name: "Enterpret",
      mimeType: "application/vnd.google-apps.folder",
      parents: [],
      webViewLink: "https://drive.google.com/drive/folders/workspace_id",
      createdTime: "2026-07-01T00:00:00.000Z",
      modifiedTime: "2026-07-01T00:00:00.000Z",
      trashed: false,
      description: WORKSPACE_DESCRIPTION,
    };
    const client = await connectedClient(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({ files: [workspace] });
    });

    const result = await client.callTool({ name: "ensure_workspace", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "found", workspace: { id: "workspace_id" } });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("test_bearer");
  });

  it("redacts bearer and Google response bodies from provider errors", async () => {
    let attempts = 0;
    const client = await connectedClient(async () => {
      attempts += 1;
      return Response.json(
        { authorization: "Bearer test_bearer", provider_secret: "GOOGLE_RESPONSE_BODY_MARKER" },
        { status: 503 },
      );
    });

    const result = await client.callTool({ name: "ensure_workspace", arguments: {} });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "error",
      error: { code: "PROVIDER_UNAVAILABLE", outcome: "not_completed", retryable: true },
    });
    expect(attempts).toBe(3);
    expect(serialized).toContain("PROVIDER_UNAVAILABLE");
    expect(serialized).not.toContain("test_bearer");
    expect(serialized).not.toContain("GOOGLE_RESPONSE_BODY_MARKER");
  });

  it("rejects local paths, base64 upload fields, public sharing, ownership, and permanent deletion", async () => {
    let providerCalls = 0;
    const client = await connectedClient(async () => {
      providerCalls += 1;
      throw new Error("invalid inputs must not dispatch");
    });

    const invalidCalls = [
      client.callTool({
        name: "create_text_file",
        arguments: { name: "x.txt", mime_type: "text/plain", local_path: "/tmp/x", content: "x" },
      }),
      client.callTool({
        name: "create_text_file",
        arguments: { name: "x.txt", mime_type: "text/plain", base64: "eA==" },
      }),
      client.callTool({
        name: "share_item",
        arguments: { item_id: "item_id", recipient_type: "anyone", role: "owner", email: "x@example.com" },
      }),
      client.callTool({ name: "delete_item", arguments: { item_id: "item_id" } }),
      client.callTool({ name: "search_authorized_items", arguments: { q: "name = 'x'" } }),
      client.callTool({ name: "search_authorized_items", arguments: { query: "x", raw_query: "trashed = false" } }),
      client.callTool({ name: "search_authorized_items", arguments: { query: "x", limit: 101 } }),
      client.callTool({
        name: "read_google_sheet",
        arguments: { spreadsheet_id: "sheet_id", range: "A:A" },
      }),
      client.callTool({
        name: "update_google_sheet",
        arguments: { spreadsheet_id: "sheet_id", range: "A1:Z1000", values: [[1]] },
      }),
      client.callTool({
        name: "update_google_sheet",
        arguments: { spreadsheet_id: "sheet_id", range: "A1:B2", values: [[1, 2], [3]] },
      }),
      client.callTool({
        name: "read_text_file",
        arguments: { item_id: "item_id", offset: 75_000, limit: 50_000 },
      }),
    ];
    const results = await Promise.all(invalidCalls);

    expect(results.every((result) => result.isError === true)).toBe(true);
    expect(providerCalls).toBe(0);
  });
});
