#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bearer = process.env.GOOGLE_DRIVE_OAUTH_BEARER;
const authorizedFolderId = process.env.GOOGLE_DRIVE_AUTHORIZED_FOLDER_ID;
const unpickedChildId = process.env.GOOGLE_DRIVE_UNPICKED_CHILD_ID;
const itemIdPattern = /^[A-Za-z0-9_-]{1,256}$/u;
const folderMime = "application/vnd.google-apps.folder";
const maximumListPages = 10;

class SmokeError extends Error {}

if (bearer === undefined || bearer.trim().length === 0) {
  throw new SmokeError("GOOGLE_DRIVE_OAUTH_BEARER must already contain a freshly refreshed access token");
}
if (authorizedFolderId === undefined || !itemIdPattern.test(authorizedFolderId)) {
  throw new SmokeError("GOOGLE_DRIVE_AUTHORIZED_FOLDER_ID must be a bounded selected Drive folder ID");
}
if (unpickedChildId === undefined || !itemIdPattern.test(unpickedChildId)) {
  throw new SmokeError("GOOGLE_DRIVE_UNPICKED_CHILD_ID must be a bounded independently added or unpicked child ID");
}
if (authorizedFolderId === unpickedChildId) {
  throw new SmokeError("the selected folder and unpicked child inputs must be different IDs");
}

function asRecord(value, operation) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmokeError(`${operation} returned an invalid structured result`);
  }
  return value;
}

function errorCode(result) {
  if (result.isError !== true) return null;
  const structured = asRecord(result.structuredContent, "error response");
  const error = asRecord(structured.error, "error response");
  return typeof error.code === "string" ? error.code : null;
}

function successResult(result, operation, expectedStatus) {
  if (result.isError === true) {
    const code = errorCode(result) ?? "UNKNOWN_ERROR";
    const ambiguity = code === "WRITE_UNKNOWN_OUTCOME" ? "; do not retry this write automatically" : "";
    throw new SmokeError(`${operation} failed with ${code}${ambiguity}`);
  }
  const structured = asRecord(result.structuredContent, operation);
  if (structured.status !== expectedStatus) {
    throw new SmokeError(`${operation} returned an unexpected status`);
  }
  return structured;
}

function resultItems(structured, operation) {
  if (!Array.isArray(structured.items) || structured.items.length > 100) {
    throw new SmokeError(`${operation} returned an invalid or unbounded item list`);
  }
  return structured.items.map((item) => asRecord(item, operation));
}

function searchFragment(name) {
  if (typeof name !== "string") throw new SmokeError("selected-folder metadata omitted its name");
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  const bounded = Array.from(cleaned).slice(0, 200).join("");
  if (bounded.length === 0) throw new SmokeError("selected-folder name cannot form a safe bounded search");
  return bounded;
}

function childEnvironment() {
  const environment = { ...process.env, GOOGLE_DRIVE_OAUTH_BEARER: bearer };
  delete environment.GOOGLE_DRIVE_AUTHORIZED_FOLDER_ID;
  delete environment.GOOGLE_DRIVE_UNPICKED_CHILD_ID;
  return environment;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, "../dist/index.js")],
  env: childEnvironment(),
  stderr: "pipe",
});
const client = new Client({ name: "google-drive-live-fresh-process-smoke", version: "1.0.0" });
const disposableName = `enterpret-mcp-live-smoke-${Date.now()}-${randomUUID().replace(/-/gu, "")}.txt`;
const initialContent = "Enterpret Google Drive MCP live smoke: initial content\n";
const updatedContent = "Enterpret Google Drive MCP live smoke: updated content\n";
let connected = false;
let createdItemId;
let primaryFailure;
let cleanupFailure;

try {
  await client.connect(transport);
  connected = true;

  const folderMetadata = successResult(
    await client.callTool({
      name: "get_item_metadata",
      arguments: { item_id: authorizedFolderId },
    }),
    "selected-folder metadata",
    "ok",
  );
  const folder = asRecord(folderMetadata.item, "selected-folder metadata");
  if (folder.id !== authorizedFolderId || folder.mime_type !== folderMime) {
    throw new SmokeError("the selected authorized ID did not resolve to the expected folder");
  }

  let cursor;
  let listedFolder = false;
  const seenCursors = new Set();
  for (let pageNumber = 0; pageNumber < maximumListPages; pageNumber += 1) {
    const listed = successResult(
      await client.callTool({
        name: "list_authorized_items",
        arguments: {
          type: "folder",
          page_size: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
      "authorized-folder listing",
      "ok",
    );
    if (resultItems(listed, "authorized-folder listing").some((item) => item.id === authorizedFolderId)) {
      listedFolder = true;
      break;
    }
    if (listed.next_cursor === null) break;
    if (typeof listed.next_cursor !== "string" || listed.next_cursor.length === 0 || seenCursors.has(listed.next_cursor)) {
      throw new SmokeError("authorized-folder listing returned an invalid continuation token");
    }
    seenCursors.add(listed.next_cursor);
    cursor = listed.next_cursor;
  }
  if (!listedFolder) {
    throw new SmokeError("the selected authorized folder was not found within the bounded authorized listing");
  }

  const searched = successResult(
    await client.callTool({
      name: "search_authorized_items",
      arguments: { query: searchFragment(folder.name), type: "folder", limit: 100 },
    }),
    "authorized-folder search",
    "ok",
  );
  if (!resultItems(searched, "authorized-folder search").some((item) => item.id === authorizedFolderId)) {
    throw new SmokeError("authorized search did not rediscover the selected folder");
  }

  const created = successResult(
    await client.callTool({
      name: "create_text_file",
      arguments: {
        name: disposableName,
        content: initialContent,
        mime_type: "text/plain",
        parent_id: authorizedFolderId,
      },
    }),
    "disposable text creation",
    "created",
  );
  const createdItem = asRecord(created.item, "disposable text creation");
  if (typeof createdItem.id !== "string" || !itemIdPattern.test(createdItem.id)) {
    throw new SmokeError("disposable text creation returned an invalid item ID");
  }
  if (!Array.isArray(createdItem.parent_ids) || !createdItem.parent_ids.includes(authorizedFolderId)) {
    throw new SmokeError("disposable text creation did not confirm the selected parent folder");
  }
  createdItemId = createdItem.id;

  const initialRead = successResult(
    await client.callTool({
      name: "read_text_file",
      arguments: { item_id: createdItemId, offset: 0, limit: 1_000 },
    }),
    "initial disposable text read",
    "ok",
  );
  if (initialRead.text !== initialContent) throw new SmokeError("initial disposable text read did not match its created content");

  successResult(
    await client.callTool({
      name: "replace_text_file",
      arguments: { item_id: createdItemId, content: updatedContent },
    }),
    "disposable text update",
    "updated",
  );

  const updatedRead = successResult(
    await client.callTool({
      name: "read_text_file",
      arguments: { item_id: createdItemId, offset: 0, limit: 1_000 },
    }),
    "updated disposable text read",
    "ok",
  );
  if (updatedRead.text !== updatedContent) throw new SmokeError("updated disposable text read did not match its replacement content");

  const unpicked = await client.callTool({
    name: "get_item_metadata",
    arguments: { item_id: unpickedChildId },
  });
  if (errorCode(unpicked) !== "DRIVE_ITEM_NOT_AUTHORIZED") {
    throw new SmokeError("the known unpicked child did not fail closed with DRIVE_ITEM_NOT_AUTHORIZED");
  }
} catch (error) {
  primaryFailure = error instanceof SmokeError ? error : new SmokeError("live fresh-process smoke failed safely");
} finally {
  if (connected && createdItemId !== undefined) {
    try {
      const trashed = successResult(
        await client.callTool({ name: "trash_item", arguments: { item_id: createdItemId } }),
        "disposable text cleanup",
        "trashed",
      );
      const trashedItem = asRecord(trashed.item, "disposable text cleanup");
      if (trashedItem.id !== createdItemId || trashedItem.trashed !== true) {
        throw new SmokeError("disposable text cleanup returned an invalid acknowledgement");
      }
    } catch (error) {
      cleanupFailure = error instanceof SmokeError
        ? error
        : new SmokeError("disposable text cleanup failed safely");
    }
  }
  if (connected) {
    try {
      await client.close();
    } catch {
      cleanupFailure ??= new SmokeError("the fresh MCP subprocess did not close cleanly");
    }
  }
}

if (cleanupFailure !== undefined) {
  throw new SmokeError(`${cleanupFailure.message}; cleanup was dispatched once and was not retried—inspect the selected folder for an enterpret-mcp-live-smoke-* file`);
}
if (primaryFailure !== undefined) throw primaryFailure;
process.stdout.write("live fresh-process authorization, discovery, mutation, and cleanup smoke passed\n");
