import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createManagedMcpServer } from "../../src/managedServer.js";
import type { FetchLike } from "../../src/managedWorkspace.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const closeCallbacks: Array<() => Promise<void>> = [];
type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;
interface ImmediateToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

function capabilities(overrides: Record<string, boolean> = {}) {
  return {
    canEdit: true,
    canCopy: true,
    canAddChildren: false,
    canDownload: true,
    canRename: true,
    canTrash: true,
    canUntrash: true,
    canModifyContent: true,
    canMoveItemWithinDrive: true,
    canMoveItemOutOfDrive: true,
    canShare: true,
    ...overrides,
  };
}

function driveFile(
  id: string,
  name: string,
  mimeType: string,
  parents: string[] = [],
  capabilityOverrides: Record<string, boolean> = {},
) {
  return {
    id,
    name,
    mimeType,
    parents,
    webViewLink: `https://drive.google.com/open?id=${id}`,
    createdTime: "2026-07-01T00:00:00.000Z",
    modifiedTime: "2026-07-01T00:00:00.000Z",
    trashed: false,
    capabilities: capabilities(capabilityOverrides),
  };
}

async function connectedClient(fetcher: FetchLike): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createManagedMcpServer({ bearer: "test_bearer", fetch: fetcher, sleep: async () => undefined });
  const client = new Client({ name: "managed-authorization-tests", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function immediateResult(result: ClientToolResult): ImmediateToolResult {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("expected an immediate MCP tool result");
  }
  return result as unknown as ImmediateToolResult;
}

function textContent(result: ClientToolResult): string {
  const block = immediateResult(result).content.find((content) => content.type === "text");
  if (block?.text === undefined) throw new Error("expected one human-readable MCP text result");
  return block.text;
}

function expectMcpError(result: ClientToolResult, code: string, messageFragment: string): void {
  const immediate = immediateResult(result);
  expect(immediate.isError).toBe(true);
  expect(immediate.structuredContent).toMatchObject({
    status: "error",
    error: { code, message: expect.stringContaining(messageFragment), outcome: "not_completed" },
  });
  const text = textContent(result);
  expect(text).toContain(code);
  expect(text).toContain(messageFragment);
  expect(JSON.parse(text)).toEqual(immediate.structuredContent);
}

describe("Phase 1 MCP authorization boundary", () => {
  it("lists and searches authorized items with structured paging, bounds, escaped server queries, and Drive compatibility flags", async () => {
    const folder = driveFile("picked_folder", "Picked folder", FOLDER_MIME, [], {
      canAddChildren: true,
      canDownload: false,
    });
    const doc = driveFile("picked_doc", "Quarter's \\ plan", DOC_MIME);
    const urls: URL[] = [];
    const client = await connectedClient(async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("fullText")) return Response.json({ files: [doc] });
      if (query.includes(`mimeType = '${FOLDER_MIME}'`)) {
        return Response.json({ files: [folder], nextPageToken: "next_page" });
      }
      throw new Error(`unexpected authorized discovery query: ${query}`);
    });

    const listed = await client.callTool({
      name: "list_authorized_items",
      arguments: { type: "folder", page_size: 10, cursor: "opaque_page" },
    });
    const searched = await client.callTool({
      name: "search_authorized_items",
      arguments: { query: "Quarter's \\ plan", type: "doc", limit: 7 },
    });

    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      status: "ok",
      items: [{ id: folder.id, mime_type: FOLDER_MIME }],
      next_cursor: "next_page",
    });
    expect(JSON.parse(textContent(listed))).toEqual(listed.structuredContent);
    expect(searched.isError).not.toBe(true);
    expect(searched.structuredContent).toMatchObject({
      status: "ok",
      items: [{ id: doc.id, mime_type: DOC_MIME }],
      next_cursor: null,
    });
    expect(JSON.parse(textContent(searched))).toEqual(searched.structuredContent);

    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.searchParams.get("supportsAllDrives") === "true")).toBe(true);
    expect(urls.every((url) => url.searchParams.get("includeItemsFromAllDrives") === "true")).toBe(true);
    expect(urls.every((url) => url.searchParams.get("corpora") === "user")).toBe(true);
    expect(urls[0]?.searchParams.get("pageSize")).toBe("10");
    expect(urls[0]?.searchParams.get("pageToken")).toBe("opaque_page");
    expect(urls[1]?.searchParams.get("pageSize")).toBe("7");
    expect(urls[1]?.searchParams.has("pageToken")).toBe(false);
    expect(urls[1]?.searchParams.has("orderBy")).toBe(false);
    expect(urls[1]?.searchParams.get("q")).toBe(
      `trashed = false and mimeType = '${DOC_MIME}' and (name contains 'Quarter\\'s \\\\ plan' or fullText contains 'Quarter\\'s \\\\ plan')`,
    );
  });

  it("reads and updates a Picker-authorized text file through MCP", async () => {
    const picked = driveFile("picked_text", "Picked.txt", "text/plain");
    let writes = 0;
    const client = await connectedClient(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [] });
      if (method === "GET" && url.pathname.endsWith(`/${picked.id}`) && url.searchParams.get("alt") === "media") {
        return new Response("picked content");
      }
      if (method === "GET" && url.pathname.endsWith(`/${picked.id}`)) return Response.json(picked);
      if (method === "PATCH" && url.pathname.endsWith(`/${picked.id}`)) {
        writes += 1;
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(String(init?.body)).toContain("replacement content");
        return Response.json(picked);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const read = await client.callTool({
      name: "read_text_file",
      arguments: { item_id: picked.id, offset: 0, limit: 100 },
    });
    const updated = await client.callTool({
      name: "replace_text_file",
      arguments: { item_id: picked.id, content: "replacement content" },
    });

    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ status: "ok", item: { id: picked.id }, text: "picked content" });
    expect(updated.isError).not.toBe(true);
    expect(updated.structuredContent).toMatchObject({ status: "updated", item: { id: picked.id } });
    expect(writes).toBe(1);
  });

  it("creates inside a selected external folder without recursively authorizing an unpicked child", async () => {
    const selectedFolder = driveFile("selected_folder", "Selected folder", FOLDER_MIME, [], {
      canAddChildren: true,
      canDownload: false,
    });
    const created = driveFile("created_text", "Created.txt", "text/plain", [selectedFolder.id]);
    let writes = 0;
    const client = await connectedClient(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method !== "GET") writes += 1;
      if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [] });
      if (method === "GET" && url.pathname.endsWith(`/${selectedFolder.id}`)) return Response.json(selectedFolder);
      if (method === "GET" && url.pathname.endsWith("/independently_added_child")) {
        return Response.json({ provider_body: "must-not-surface" }, { status: 404 });
      }
      if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(String(init?.body)).toContain(`"parents":["${selectedFolder.id}"]`);
        return Response.json(created);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const folderMetadata = await client.callTool({
      name: "get_item_metadata",
      arguments: { item_id: selectedFolder.id },
    });
    const creation = await client.callTool({
      name: "create_text_file",
      arguments: {
        name: created.name,
        content: "created content",
        mime_type: "text/plain",
        parent_id: selectedFolder.id,
      },
    });
    const writesBeforeChildRead = writes;
    const child = await client.callTool({
      name: "get_item_metadata",
      arguments: { item_id: "independently_added_child" },
    });

    expect(folderMetadata.isError).not.toBe(true);
    expect(folderMetadata.structuredContent).toMatchObject({ status: "ok", item: { id: selectedFolder.id } });
    expect(creation.isError).not.toBe(true);
    expect(creation.structuredContent).toMatchObject({
      status: "created",
      item: { id: created.id, parent_ids: [selectedFolder.id] },
    });
    expectMcpError(child, "DRIVE_ITEM_NOT_AUTHORIZED", "not authorized");
    expect(writesBeforeChildRead).toBe(1);
    expect(writes).toBe(writesBeforeChildRead);
    expect(JSON.stringify(child)).not.toContain("must-not-surface");
  });

  it("returns every Phase 1 failure code in both MCP text and structured content before writes", async () => {
    const denied = driveFile("denied_text", "Denied.txt", "text/plain", [], { canDownload: false });
    const folder = driveFile("unsupported_folder", "Folder", FOLDER_MIME, [], {
      canAddChildren: true,
      canDownload: false,
    });
    const vanished = driveFile("vanished_text", "Vanished.txt", "text/plain");
    let writes = 0;
    const client = await connectedClient(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method !== "GET") writes += 1;
      if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [] });
      if (method === "GET" && url.pathname.endsWith("/unpicked_item")) return Response.json({}, { status: 404 });
      if (method === "GET" && url.pathname.endsWith("/unpicked_parent")) return Response.json({}, { status: 404 });
      if (method === "GET" && url.pathname.endsWith(`/${denied.id}`)) return Response.json(denied);
      if (method === "GET" && url.pathname.endsWith(`/${folder.id}`)) return Response.json(folder);
      if (method === "GET" && url.pathname.endsWith(`/${vanished.id}`)) {
        if (url.searchParams.get("alt") === "media") {
          return Response.json({ provider_body: "must-not-surface" }, { status: 404 });
        }
        return Response.json(vanished);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const failures = [
      {
        result: await client.callTool({ name: "get_item_metadata", arguments: { item_id: "unpicked_item" } }),
        code: "DRIVE_ITEM_NOT_AUTHORIZED",
        message: "not authorized",
      },
      {
        result: await client.callTool({
          name: "read_text_file",
          arguments: { item_id: denied.id, offset: 0, limit: 10 },
        }),
        code: "DRIVE_CAPABILITY_DENIED",
        message: "does not grant",
      },
      {
        result: await client.callTool({
          name: "read_text_file",
          arguments: { item_id: folder.id, offset: 0, limit: 10 },
        }),
        code: "DRIVE_ITEM_TYPE_UNSUPPORTED",
        message: "not supported",
      },
      {
        result: await client.callTool({
          name: "create_folder",
          arguments: { name: "Blocked", parent_id: "unpicked_parent" },
        }),
        code: "DRIVE_PARENT_NOT_AUTHORIZED",
        message: "parent folder is not authorized",
      },
      {
        result: await client.callTool({
          name: "read_text_file",
          arguments: { item_id: vanished.id, offset: 0, limit: 10 },
        }),
        code: "DRIVE_ITEM_NOT_FOUND",
        message: "no longer exists",
      },
    ];

    for (const failure of failures) expectMcpError(failure.result, failure.code, failure.message);
    expect(writes).toBe(0);
    expect(JSON.stringify(failures)).not.toContain("must-not-surface");
  });
});
