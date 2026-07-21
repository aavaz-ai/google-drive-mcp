import { randomUUID } from "node:crypto";

import { GoogleDriveMcpError } from "./managedErrors.js";
import {
  MAX_READ_LENGTH,
  MAX_SLIDES,
  MAX_TEXT_LENGTH,
  sheetValuesSchema,
  type CellValue,
  type CopyItemInput,
  type CreateFolderInput,
  type CreateGoogleDocInput,
  type CreateGooglePresentationInput,
  type CreateGoogleSheetInput,
  type CreateTextFileInput,
  type ListWorkspaceItemsInput,
  type ListItemPermissionsInput,
  type ReadGoogleDocInput,
  type ReadGooglePresentationInput,
  type ReadGoogleSheetInput,
  type ReadTextFileInput,
  type RemoveItemPermissionInput,
  type RenameItemInput,
  type ReplaceTextFileInput,
  type SearchWorkspaceItemsInput,
  type ShareItemInput,
  type SlideInput,
  type UpdateGoogleDocInput,
  type UpdateGooglePresentationInput,
  type UpdateGoogleSheetInput,
} from "./tools/managedSchemas.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES_API = "https://slides.googleapis.com/v1/presentations";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const PRESENTATION_MIME = "application/vnd.google-apps.presentation";
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv"]);

export const WORKSPACE_NAME = "Enterpret";
export const WORKSPACE_DESCRIPTION =
  "Managed by the Enterpret Google Drive connector. Content inside may be changed by the connected agent.";

const FILE_FIELDS = "id,name,mimeType,parents,webViewLink,createdTime,modifiedTime,trashed,description";
const READ_RETRY_DELAYS_MS = [0, 100, 300] as const;
const MAX_ANCESTRY_NODES = 256;
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_RESPONSE_BYTES = MAX_TEXT_LENGTH * 4;
const MAX_INTERNAL_PAGES = 10;
const MAX_PAGE_TOKEN_LENGTH = 2_048;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;
type JsonRecord = Record<string, unknown>;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
  description?: string;
}

interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string;
}

export interface ItemReference {
  id: string;
  name: string;
  mime_type: string;
  parent_ids: string[];
  web_view_link: string | null;
  created_time: string | null;
  modified_time: string | null;
  trashed: boolean;
}

export interface PermissionReference {
  id: string;
  type: string;
  role: string;
  email: string | null;
  domain: string | null;
}

interface GoogleDriveClientOptions {
  fetch?: FetchLike;
  sleep?: Sleep;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
  return value as JsonRecord;
}

function asDriveFile(value: unknown): DriveFile {
  const record = asRecord(value);
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.mimeType !== "string" ||
    (record.parents !== undefined &&
      (!Array.isArray(record.parents) || record.parents.some((parent) => typeof parent !== "string"))) ||
    (record.webViewLink !== undefined && typeof record.webViewLink !== "string") ||
    (record.createdTime !== undefined && typeof record.createdTime !== "string") ||
    (record.modifiedTime !== undefined && typeof record.modifiedTime !== "string") ||
    (record.trashed !== undefined && typeof record.trashed !== "boolean") ||
    (record.description !== undefined && typeof record.description !== "string")
  ) {
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
  return record as unknown as DriveFile;
}

function itemReference(file: DriveFile): ItemReference {
  return {
    id: file.id,
    name: file.name,
    mime_type: file.mimeType,
    parent_ids: file.parents ?? [],
    web_view_link: typeof file.webViewLink === "string" ? file.webViewLink : null,
    created_time: typeof file.createdTime === "string" ? file.createdTime : null,
    modified_time: typeof file.modifiedTime === "string" ? file.modifiedTime : null,
    trashed: file.trashed === true,
  };
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

function compareWorkspaceCandidates(left: DriveFile, right: DriveFile): number {
  const leftCreated = left.createdTime ?? "";
  const rightCreated = right.createdTime ?? "";
  const createdComparison = leftCreated.localeCompare(rightCreated);
  return createdComparison === 0 ? left.id.localeCompare(right.id) : createdComparison;
}

function statusError(status: number): GoogleDriveMcpError {
  if (status === 401) return new GoogleDriveMcpError("authentication_failed", { providerStatus: status });
  if (status === 403) return new GoogleDriveMcpError("permission_denied", { providerStatus: status });
  if (status === 404) return new GoogleDriveMcpError("not_found", { providerStatus: status });
  if (status === 409 || status === 412) return new GoogleDriveMcpError("conflict", { providerStatus: status });
  if (status === 429) return new GoogleDriveMcpError("rate_limited", { providerStatus: status });
  if (status >= 500) return new GoogleDriveMcpError("provider_unavailable", { providerStatus: status });
  return new GoogleDriveMcpError("provider_rejected", { providerStatus: status });
}

function unknownWriteOutcome(error: unknown): GoogleDriveMcpError {
  if (error instanceof GoogleDriveMcpError && error.code === "write_unknown_outcome") return error;
  return new GoogleDriveMcpError("write_unknown_outcome", {
    outcome: "unknown",
    ...(error instanceof GoogleDriveMcpError && error.providerStatus !== undefined
      ? { providerStatus: error.providerStatus }
      : {}),
  });
}

async function readBoundedBody(response: Response, maximumBytes: number, operation: "read" | "write"): Promise<Uint8Array> {
  const invalidResponse = (): GoogleDriveMcpError =>
    operation === "write"
      ? unknownWriteOutcome(new GoogleDriveMcpError("provider_invalid_response"))
      : new GoogleDriveMcpError("provider_invalid_response");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw invalidResponse();
    }
  }
  if (response.body === null) return new Uint8Array();

  // Provider size headers are advisory. Enforce the same cap while streaming
  // so a missing or false Content-Length cannot create an unbounded read.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw invalidResponse();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoogleDriveMcpError) throw error;
    if (operation === "write") throw unknownWriteOutcome(error);
    throw new GoogleDriveMcpError("provider_unavailable");
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeUtf8(body: Uint8Array, operation: "read" | "write"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    if (operation === "write") throw unknownWriteOutcome(error);
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
}

function parseWriteResult<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw unknownWriteOutcome(error);
  }
}

function assertDriveFilePostcondition(
  file: DriveFile,
  expected: {
    id?: string;
    differentFromId?: string;
    name?: string;
    mimeType?: string;
    parentId?: string;
    trashed?: boolean;
  },
): DriveFile {
  if (expected.id !== undefined && file.id !== expected.id) throw new GoogleDriveMcpError("provider_invalid_response");
  if (expected.differentFromId !== undefined && file.id === expected.differentFromId) {
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
  if (expected.name !== undefined && file.name !== expected.name) throw new GoogleDriveMcpError("provider_invalid_response");
  if (expected.mimeType !== undefined && file.mimeType !== expected.mimeType) {
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
  if (expected.parentId !== undefined && !(file.parents ?? []).includes(expected.parentId)) {
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
  if (expected.trashed !== undefined && file.trashed !== expected.trashed) {
    throw new GoogleDriveMcpError("provider_invalid_response");
  }
  return file;
}

function singleDocumentBody(document: JsonRecord): JsonRecord {
  if (document.tabs === undefined) return asRecord(document.body);
  if (!Array.isArray(document.tabs)) throw new GoogleDriveMcpError("provider_invalid_response");
  const tabs: JsonRecord[] = [];
  const collectTabs = (values: unknown[]): void => {
    for (const value of values) {
      const tab = asRecord(value);
      tabs.push(tab);
      if (tab.childTabs !== undefined) {
        if (!Array.isArray(tab.childTabs)) throw new GoogleDriveMcpError("provider_invalid_response");
        collectTabs(tab.childTabs);
      }
    }
  };
  collectTabs(document.tabs);
  if (tabs.length === 0) throw new GoogleDriveMcpError("provider_invalid_response");
  if (tabs.length > 1) {
    // V0 deliberately rejects multi-tab Docs instead of silently reading or
    // replacing only one tab and claiming complete-document behavior.
    throw new GoogleDriveMcpError("invalid_input");
  }
  return asRecord(asRecord(tabs[0]?.documentTab).body);
}

function documentContent(body: JsonRecord): unknown[] {
  if (!Array.isArray(body.content)) throw new GoogleDriveMcpError("provider_invalid_response");
  return body.content;
}

function sliceText(text: string, offset: number, limit: number): { text: string; next_offset: number | null } {
  const sliced = text.slice(offset, offset + limit);
  const nextOffset = offset + sliced.length < text.length ? offset + sliced.length : null;
  return { text: sliced, next_offset: nextOffset };
}

function extractDocumentText(value: unknown, maximumCharacters = MAX_TEXT_LENGTH): string {
  const fragments: string[] = [];
  let characterCount = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as JsonRecord;
    const textRun = record.textRun;
    if (typeof textRun === "object" && textRun !== null && !Array.isArray(textRun)) {
      const content = (textRun as JsonRecord).content;
      if (typeof content === "string") {
        characterCount += content.length;
        if (characterCount > maximumCharacters) throw new GoogleDriveMcpError("provider_invalid_response");
        fragments.push(content);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "textRun") visit(child);
    }
  };
  visit(value);
  return fragments.join("");
}

function extractSlideTexts(slide: unknown): string[] {
  const text = extractDocumentText(slide);
  return text
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export class GoogleDriveClient {
  private readonly bearer: string;
  private readonly fetch: FetchLike;
  private readonly sleep: Sleep;

  constructor(bearer: string, options: GoogleDriveClientOptions = {}) {
    this.bearer = bearer;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async request(
    url: string,
    init: RequestInit,
    operation: "read" | "write",
  ): Promise<Response> {
    const attempts = operation === "read" ? READ_RETRY_DELAYS_MS.length : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.sleep(READ_RETRY_DELAYS_MS[attempt] ?? 0);
      let response: Response;
      try {
        response = await this.fetch(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.bearer}`,
            ...init.headers,
          },
        });
      } catch {
        if (operation === "write") {
          throw new GoogleDriveMcpError("write_unknown_outcome", { outcome: "unknown" });
        }
        if (attempt + 1 < attempts) continue;
        throw new GoogleDriveMcpError("provider_unavailable");
      }
      if (response.ok) return response;
      if (operation === "read" && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        continue;
      }
      if (operation === "write" && response.status >= 500) {
        throw new GoogleDriveMcpError("write_unknown_outcome", {
          outcome: "unknown",
          providerStatus: response.status,
        });
      }
      throw statusError(response.status);
    }
    throw new GoogleDriveMcpError("provider_unavailable");
  }

  private async readJson(url: string): Promise<unknown> {
    const { body } = await this.readBytes(url, { method: "GET" }, MAX_JSON_RESPONSE_BYTES);
    try {
      return JSON.parse(decodeUtf8(body, "read")) as unknown;
    } catch (error) {
      if (error instanceof GoogleDriveMcpError) throw error;
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
  }

  private async readBytes(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ response: Response; body: Uint8Array }> {
    for (let attempt = 0; attempt < READ_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await this.sleep(READ_RETRY_DELAYS_MS[attempt] ?? 0);
      const response = await this.request(url, init, "read");
      try {
        return { response, body: await readBoundedBody(response, maximumBytes, "read") };
      } catch (error) {
        const transientBodyFailure =
          error instanceof GoogleDriveMcpError && error.code === "provider_unavailable";
        if (transientBodyFailure && attempt + 1 < READ_RETRY_DELAYS_MS.length) continue;
        throw error;
      }
    }
    throw new GoogleDriveMcpError("provider_unavailable");
  }

  private async writeJson(url: string, method: "POST" | "PATCH" | "PUT", body?: unknown): Promise<unknown> {
    const response = await this.request(
      url,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      },
      "write",
    );
    // Once a write has returned 2xx, a missing or malformed acknowledgement
    // cannot prove whether the provider committed it. Preserve that ambiguity.
    if (response.status === 204) throw unknownWriteOutcome(new GoogleDriveMcpError("provider_invalid_response"));
    try {
      const responseBody = await readBoundedBody(response, MAX_JSON_RESPONSE_BYTES, "write");
      return JSON.parse(decodeUtf8(responseBody, "write")) as unknown;
    } catch (error) {
      throw unknownWriteOutcome(error);
    }
  }

  private async deleteWrite(url: string): Promise<void> {
    const response = await this.request(url, { method: "DELETE" }, "write");
    if (response.status !== 204) throw unknownWriteOutcome(new GoogleDriveMcpError("provider_invalid_response"));
    const body = await readBoundedBody(response, 0, "write");
    if (body.byteLength !== 0) throw unknownWriteOutcome(new GoogleDriveMcpError("provider_invalid_response"));
  }

  private async getFile(itemId: string): Promise<DriveFile> {
    const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "false" });
    return asDriveFile(await this.readJson(`${DRIVE_API}/files/${encodePathPart(itemId)}?${query}`));
  }

  private async listFiles(
    queryText: string,
    pageSize = 100,
    cursor?: string,
    orderBy: string | null = "createdTime asc,name_natural",
  ): Promise<DriveFileList> {
    const query = new URLSearchParams({
      q: queryText,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: String(pageSize),
      spaces: "drive",
    });
    if (orderBy !== null) query.set("orderBy", orderBy);
    if (cursor !== undefined) query.set("pageToken", cursor);
    const result = asRecord(await this.readJson(`${DRIVE_API}/files?${query}`));
    if (!Array.isArray(result.files) || result.files.length > pageSize) {
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
    const files = result.files.map(asDriveFile);
    if (
      result.nextPageToken !== undefined &&
      (typeof result.nextPageToken !== "string" ||
        result.nextPageToken.length === 0 ||
        result.nextPageToken.length > MAX_PAGE_TOKEN_LENGTH)
    ) {
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
    return {
      files,
      ...(typeof result.nextPageToken === "string" ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  private async findWorkspace(includeTrashed: boolean): Promise<DriveFile | null> {
    const name = escapeDriveQuery(WORKSPACE_NAME);
    const trashedClause = includeTrashed ? "" : " and trashed = false";
    const query = `mimeType = '${FOLDER_MIME}' and name = '${name}'${trashedClause}`;
    const candidates: DriveFile[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_INTERNAL_PAGES; pageNumber += 1) {
      const page = await this.listFiles(query, 100, cursor);
      for (const file of page.files ?? []) {
        if (file.description !== WORKSPACE_DESCRIPTION) continue;
        if (typeof file.createdTime !== "string") throw new GoogleDriveMcpError("provider_invalid_response");
        candidates.push(file);
      }
      cursor = page.nextPageToken;
      if (cursor === undefined) return candidates.sort(compareWorkspaceCandidates)[0] ?? null;
      if (seenCursors.has(cursor)) throw new GoogleDriveMcpError("provider_invalid_response");
      seenCursors.add(cursor);
    }
    // An incomplete workspace search must not fall through to creation: doing
    // so could create a duplicate marker outside the pages we inspected.
    throw new GoogleDriveMcpError("provider_invalid_response");
  }

  private async activeWorkspace(): Promise<DriveFile> {
    const workspace = await this.findWorkspace(false);
    if (workspace === null) throw new GoogleDriveMcpError("workspace_not_initialized");
    return workspace;
  }

  private async createDriveFile(metadata: JsonRecord): Promise<DriveFile> {
    const query = new URLSearchParams({ fields: FILE_FIELDS });
    const result = await this.writeJson(`${DRIVE_API}/files?${query}`, "POST", metadata);
    return parseWriteResult(() =>
      assertDriveFilePostcondition(asDriveFile(result), {
        ...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
        ...(typeof metadata.mimeType === "string" ? { mimeType: metadata.mimeType } : {}),
        ...(Array.isArray(metadata.parents) && typeof metadata.parents[0] === "string"
          ? { parentId: metadata.parents[0] }
          : {}),
        trashed: false,
      }),
    );
  }

  private async assertInsideWorkspace(itemId: string, options: { allowRoot?: boolean } = {}): Promise<{ item: DriveFile; workspace: DriveFile }> {
    const workspace = await this.activeWorkspace();
    const item = await this.getFile(itemId);
    if (item.id === workspace.id) {
      if (options.allowRoot === false) throw new GoogleDriveMcpError("outside_workspace");
      return { item, workspace };
    }

    const visited = new Set<string>([item.id]);
    const frontier = [...(item.parents ?? [])];
    while (frontier.length > 0) {
      const parentId = frontier.shift();
      if (parentId === undefined || visited.has(parentId)) continue;
      if (parentId === workspace.id) return { item, workspace };
      if (visited.size >= MAX_ANCESTRY_NODES) {
        // Exhaustion is not evidence that the item is outside or inside. Fail
        // closed before any caller can use the unresolved ancestry for a write.
        throw new GoogleDriveMcpError("outside_workspace");
      }
      visited.add(parentId);
      let parent: DriveFile;
      try {
        parent = await this.getFile(parentId);
      } catch (error) {
        if (
          error instanceof GoogleDriveMcpError &&
          (error.code === "not_found" || error.code === "permission_denied")
        ) {
          throw new GoogleDriveMcpError("outside_workspace");
        }
        throw error;
      }
      frontier.push(...(parent.parents ?? []));
    }
    throw new GoogleDriveMcpError("outside_workspace");
  }

  private async managedParent(parentId: string | undefined, createWorkspace: boolean): Promise<DriveFile> {
    const workspace = createWorkspace ? (await this.ensureWorkspace()).workspace : itemReference(await this.activeWorkspace());
    if (parentId === undefined || parentId === workspace.id) return this.getFile(workspace.id);
    const { item } = await this.assertInsideWorkspace(parentId);
    if (item.mimeType !== FOLDER_MIME || item.trashed === true) throw new GoogleDriveMcpError("invalid_input");
    return item;
  }

  private async isDescendantOf(itemId: string, possibleAncestorId: string): Promise<boolean> {
    const visited = new Set<string>();
    const frontier = [itemId];
    while (frontier.length > 0) {
      const currentId = frontier.shift();
      if (currentId === undefined || visited.has(currentId)) continue;
      if (currentId === possibleAncestorId) return true;
      if (visited.size >= MAX_ANCESTRY_NODES) {
        // A false result after exhaustion would permit a potentially cyclic
        // folder move. Treat an unresolved graph as invalid instead.
        throw new GoogleDriveMcpError("invalid_input");
      }
      visited.add(currentId);
      const current = await this.getFile(currentId);
      frontier.push(...(current.parents ?? []));
    }
    return false;
  }

  private assertMime(item: DriveFile, expected: string | Set<string>): void {
    const matches = typeof expected === "string" ? item.mimeType === expected : expected.has(item.mimeType);
    if (!matches) throw new GoogleDriveMcpError("invalid_input");
  }

  private async uploadText(
    metadata: JsonRecord,
    content: string,
    mimeType: string,
    method: "POST" | "PATCH" = "POST",
    existingItem?: DriveFile,
  ): Promise<DriveFile> {
    const boundary = `enterpret_${randomUUID().replace(/-/gu, "")}`;
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n`),
      Buffer.from(content, "utf8"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const query = new URLSearchParams({ uploadType: "multipart", fields: FILE_FIELDS });
    const path = existingItem === undefined ? "/files" : `/files/${encodePathPart(existingItem.id)}`;
    const response = await this.request(
      `${DRIVE_UPLOAD_API}${path}?${query}`,
      {
        method,
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      },
      "write",
    );
    try {
      const responseBody = await readBoundedBody(response, MAX_JSON_RESPONSE_BYTES, "write");
      const result = JSON.parse(decodeUtf8(responseBody, "write")) as unknown;
      return parseWriteResult(() =>
        assertDriveFilePostcondition(asDriveFile(result), {
          ...(existingItem === undefined ? {} : { id: existingItem.id }),
          name:
            typeof metadata.name === "string"
              ? metadata.name
              : existingItem?.name,
          mimeType,
          ...(Array.isArray(metadata.parents) && typeof metadata.parents[0] === "string"
            ? { parentId: metadata.parents[0] }
            : existingItem?.parents?.[0] === undefined
              ? {}
              : { parentId: existingItem.parents[0] }),
          trashed: false,
        }),
      );
    } catch (error) {
      throw unknownWriteOutcome(error);
    }
  }

  private async document(documentId: string): Promise<JsonRecord> {
    const query = new URLSearchParams({ includeTabsContent: "true" });
    return asRecord(await this.readJson(`${DOCS_API}/${encodePathPart(documentId)}?${query}`));
  }

  private async populateDocument(documentId: string, content: string): Promise<void> {
    if (content.length === 0) return;
    const result = await this.writeJson(`${DOCS_API}/${encodePathPart(documentId)}:batchUpdate`, "POST", {
      requests: [{ insertText: { location: { index: 1 }, text: content } }],
    });
    parseWriteResult(() => {
      if (asRecord(result).documentId !== documentId) throw new GoogleDriveMcpError("provider_invalid_response");
    });
  }

  private async replaceDocument(documentId: string, content: string): Promise<void> {
    const document = await this.document(documentId);
    const body = singleDocumentBody(document);
    const contentNodes = documentContent(body);
    let endIndex = 1;
    for (const node of contentNodes) {
      const candidate = asRecord(node).endIndex;
      if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 1) {
        throw new GoogleDriveMcpError("provider_invalid_response");
      }
      endIndex = Math.max(endIndex, candidate);
    }
    const requests: JsonRecord[] = [];
    if (endIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
    if (content.length > 0) requests.push({ insertText: { location: { index: 1 }, text: content } });
    if (requests.length > 0) {
      const result = await this.writeJson(`${DOCS_API}/${encodePathPart(documentId)}:batchUpdate`, "POST", { requests });
      parseWriteResult(() => {
        if (asRecord(result).documentId !== documentId) throw new GoogleDriveMcpError("provider_invalid_response");
      });
    }
  }

  private async writeSheet(spreadsheetId: string, range: string, values: CellValue[][], valueInputOption: "RAW" | "USER_ENTERED"): Promise<void> {
    const query = new URLSearchParams({ valueInputOption });
    const result = await this.writeJson(
      `${SHEETS_API}/${encodePathPart(spreadsheetId)}/values/${encodePathPart(range)}?${query}`,
      "PUT",
      { range, majorDimension: "ROWS", values },
    );
    parseWriteResult(() => {
      const acknowledgement = asRecord(result);
      const expectedRows = values.length;
      const expectedColumns = values[0]?.length ?? 0;
      const expectedCells = expectedRows * expectedColumns;
      if (
        acknowledgement.spreadsheetId !== spreadsheetId ||
        typeof acknowledgement.updatedRange !== "string" ||
        acknowledgement.updatedRows !== expectedRows ||
        acknowledgement.updatedColumns !== expectedColumns ||
        acknowledgement.updatedCells !== expectedCells
      ) {
        throw new GoogleDriveMcpError("provider_invalid_response");
      }
    });
  }

  private presentationRequests(slides: SlideInput[], existingSlideIds: string[]): JsonRecord[] {
    const requests: JsonRecord[] = existingSlideIds.map((objectId) => ({ deleteObject: { objectId } }));
    for (const slide of slides) {
      const suffix = randomUUID().replace(/-/gu, "");
      const slideId = `enterpret_slide_${suffix}`;
      const titleId = `enterpret_title_${suffix}`;
      const bodyId = `enterpret_body_${suffix}`;
      requests.push({
        createSlide: {
          objectId: slideId,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: titleId },
            { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: bodyId },
          ],
        },
      });
      if (slide.title.length > 0) requests.push({ insertText: { objectId: titleId, text: slide.title, insertionIndex: 0 } });
      if (slide.body.length > 0) requests.push({ insertText: { objectId: bodyId, text: slide.body, insertionIndex: 0 } });
    }
    return requests;
  }

  private async replacePresentation(presentationId: string, slides: SlideInput[]): Promise<void> {
    const presentation = asRecord(await this.readJson(`${SLIDES_API}/${encodePathPart(presentationId)}`));
    if (!Array.isArray(presentation.slides)) throw new GoogleDriveMcpError("provider_invalid_response");
    const existingSlideIds = presentation.slides.map((page) => {
      const objectId = asRecord(page).objectId;
      if (typeof objectId !== "string" || objectId.length === 0) {
        throw new GoogleDriveMcpError("provider_invalid_response");
      }
      return objectId;
    });
    const result = await this.writeJson(`${SLIDES_API}/${encodePathPart(presentationId)}:batchUpdate`, "POST", {
      requests: this.presentationRequests(slides, existingSlideIds),
    });
    parseWriteResult(() => {
      if (asRecord(result).presentationId !== presentationId) {
        throw new GoogleDriveMcpError("provider_invalid_response");
      }
    });
  }

  async ensureWorkspace(): Promise<{ status: "found" | "created" | "restored"; workspace: ItemReference }> {
    const active = await this.findWorkspace(false);
    if (active !== null) return { status: "found", workspace: itemReference(active) };

    const anyWorkspace = await this.findWorkspace(true);
    if (anyWorkspace !== null) {
      const result = await this.writeJson(
        `${DRIVE_API}/files/${encodePathPart(anyWorkspace.id)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
        "PATCH",
        {
          trashed: false,
        },
      );
      const restored = parseWriteResult(() =>
        assertDriveFilePostcondition(asDriveFile(result), { id: anyWorkspace.id, trashed: false }),
      );
      return { status: "restored", workspace: itemReference(restored) };
    }

    const created = await this.createDriveFile({
      name: WORKSPACE_NAME,
      mimeType: FOLDER_MIME,
      description: WORKSPACE_DESCRIPTION,
    });
    return { status: "created", workspace: itemReference(created) };
  }

  async createFolder(input: CreateFolderInput): Promise<{ status: "created"; item: ItemReference }> {
    const parent = await this.managedParent(input.parent_id, true);
    const item = await this.createDriveFile({ name: input.name, mimeType: FOLDER_MIME, parents: [parent.id] });
    return { status: "created", item: itemReference(item) };
  }

  async createTextFile(input: CreateTextFileInput): Promise<{ status: "created"; item: ItemReference }> {
    const parent = await this.managedParent(input.parent_id, true);
    const item = await this.uploadText({ name: input.name, mimeType: input.mime_type, parents: [parent.id] }, input.content, input.mime_type);
    return { status: "created", item: itemReference(item) };
  }

  async createGoogleDoc(input: CreateGoogleDocInput): Promise<{ status: "created"; item: ItemReference }> {
    const parent = await this.managedParent(input.parent_id, true);
    const item = await this.createDriveFile({ name: input.name, mimeType: DOC_MIME, parents: [parent.id] });
    try {
      await this.populateDocument(item.id, input.content);
    } catch (error) {
      throw unknownWriteOutcome(error);
    }
    return { status: "created", item: itemReference(item) };
  }

  async createGoogleSheet(input: CreateGoogleSheetInput): Promise<{ status: "created"; item: ItemReference }> {
    const parent = await this.managedParent(input.parent_id, true);
    const item = await this.createDriveFile({ name: input.name, mimeType: SHEET_MIME, parents: [parent.id] });
    if (input.values.length > 0) {
      try {
        await this.writeSheet(item.id, "A1", input.values, input.value_input_option);
      } catch (error) {
        throw unknownWriteOutcome(error);
      }
    }
    return { status: "created", item: itemReference(item) };
  }

  async createGooglePresentation(input: CreateGooglePresentationInput): Promise<{ status: "created"; item: ItemReference }> {
    const parent = await this.managedParent(input.parent_id, true);
    const item = await this.createDriveFile({ name: input.name, mimeType: PRESENTATION_MIME, parents: [parent.id] });
    try {
      await this.replacePresentation(item.id, input.slides);
    } catch (error) {
      throw unknownWriteOutcome(error);
    }
    return { status: "created", item: itemReference(item) };
  }

  async shareItem(input: ShareItemInput): Promise<{ status: "shared"; permission: PermissionReference }> {
    await this.assertInsideWorkspace(input.item_id, { allowRoot: false });
    const query = new URLSearchParams({
      sendNotificationEmail: String(input.send_notification),
      fields: "id,type,role,emailAddress,domain",
    });
    const result = await this.writeJson(`${DRIVE_API}/files/${encodePathPart(input.item_id)}/permissions?${query}`, "POST", {
        type: input.recipient_type,
        role: input.role,
        emailAddress: input.email,
      });
    const permission = parseWriteResult(() => {
      const response = asRecord(result);
      const parsed = this.permissionReference(response);
      if (
        parsed.type !== input.recipient_type ||
        parsed.role !== input.role ||
        response.emailAddress !== input.email
      ) {
        throw new GoogleDriveMcpError("provider_invalid_response");
      }
      return parsed;
    });
    return { status: "shared", permission };
  }

  async listWorkspaceItems(input: ListWorkspaceItemsInput): Promise<{ status: "ok"; items: ItemReference[]; next_cursor: string | null }> {
    const parent = await this.managedParent(input.parent_id, false);
    const page = await this.listFiles(`'${escapeDriveQuery(parent.id)}' in parents and trashed = false`, input.page_size, input.cursor);
    return {
      status: "ok",
      items: (page.files ?? []).map(itemReference),
      next_cursor: page.nextPageToken ?? null,
    };
  }

  async searchWorkspaceItems(input: SearchWorkspaceItemsInput): Promise<{ status: "ok"; items: ItemReference[]; next_cursor: string | null }> {
    await this.activeWorkspace();
    const escaped = escapeDriveQuery(input.query);
    const matches: ItemReference[] = [];
    // Google Drive rejects every orderBy value when q contains fullText and
    // already returns those matches in descending relevance order. Omitting
    // ordering here preserves valid full-text search while other listings keep
    // their deterministic created-time/name ordering.
    const page = await this.listFiles(
      `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`,
      input.page_size,
      input.cursor,
      null,
    );
    for (const file of page.files ?? []) {
      try {
        await this.assertInsideWorkspace(file.id);
        matches.push(itemReference(file));
      } catch (error) {
        if (!(error instanceof GoogleDriveMcpError) || error.code !== "outside_workspace") throw error;
      }
    }
    return { status: "ok", items: matches, next_cursor: page.nextPageToken ?? null };
  }

  async getItemMetadata(itemId: string): Promise<{ status: "ok"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(itemId);
    return { status: "ok", item: itemReference(item) };
  }

  async readTextFile(input: ReadTextFileInput): Promise<{ status: "ok"; item: ItemReference; text: string; next_offset: number | null }> {
    const { item } = await this.assertInsideWorkspace(input.item_id);
    this.assertMime(item, TEXT_MIMES);
    const { response, body } = await this.readBytes(
      `${DRIVE_API}/files/${encodePathPart(item.id)}?alt=media`,
      { method: "GET", headers: { Range: `bytes=0-${MAX_TEXT_RESPONSE_BYTES - 1}` } },
      MAX_TEXT_RESPONSE_BYTES,
    );
    const contentRange = response.headers.get("content-range");
    if (response.status === 206 && contentRange === null) {
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
    if (contentRange !== null) {
      const match = /\/(\d+)$/u.exec(contentRange);
      if (match === null || Number(match[1]) > MAX_TEXT_RESPONSE_BYTES) {
        throw new GoogleDriveMcpError("provider_invalid_response");
      }
    }
    const text = decodeUtf8(body, "read");
    if (text.length > MAX_TEXT_LENGTH) throw new GoogleDriveMcpError("provider_invalid_response");
    return { status: "ok", item: itemReference(item), ...sliceText(text, input.offset, input.limit) };
  }

  async readGoogleDoc(input: ReadGoogleDocInput): Promise<{ status: "ok"; item: ItemReference; text: string; next_offset: number | null }> {
    const { item } = await this.assertInsideWorkspace(input.document_id);
    this.assertMime(item, DOC_MIME);
    const body = singleDocumentBody(await this.document(item.id));
    return {
      status: "ok",
      item: itemReference(item),
      ...sliceText(extractDocumentText(documentContent(body)), input.offset, input.limit),
    };
  }

  async readGoogleSheet(input: ReadGoogleSheetInput): Promise<{ status: "ok"; item: ItemReference; range: string; values: CellValue[][] }> {
    const { item } = await this.assertInsideWorkspace(input.spreadsheet_id);
    this.assertMime(item, SHEET_MIME);
    const valueRange = asRecord(await this.readJson(`${SHEETS_API}/${encodePathPart(item.id)}/values/${encodePathPart(input.range)}`));
    const parsedValues = sheetValuesSchema.safeParse(valueRange.values ?? []);
    if (!parsedValues.success) throw new GoogleDriveMcpError("provider_invalid_response");
    const values = parsedValues.data;
    return { status: "ok", item: itemReference(item), range: typeof valueRange.range === "string" ? valueRange.range : input.range, values };
  }

  async readGooglePresentation(input: ReadGooglePresentationInput): Promise<{ status: "ok"; item: ItemReference; slides: { index: number; texts: string[] }[]; truncated: boolean }> {
    const { item } = await this.assertInsideWorkspace(input.presentation_id);
    this.assertMime(item, PRESENTATION_MIME);
    const presentation = asRecord(await this.readJson(`${SLIDES_API}/${encodePathPart(item.id)}`));
    if (!Array.isArray(presentation.slides)) throw new GoogleDriveMcpError("provider_invalid_response");
    const slides = presentation.slides;
    const selected = input.slide_index === undefined ? slides.slice(0, MAX_SLIDES) : slides.slice(input.slide_index, input.slide_index + 1);
    let remainingCharacters = MAX_READ_LENGTH;
    let truncated = input.slide_index === undefined && slides.length > selected.length;
    const boundedSlides = selected.map((slide, relativeIndex) => {
      const texts: string[] = [];
      for (const text of extractSlideTexts(slide)) {
        if (remainingCharacters === 0) {
          truncated = true;
          break;
        }
        const boundedText = text.slice(0, remainingCharacters);
        texts.push(boundedText);
        remainingCharacters -= boundedText.length;
        if (boundedText.length < text.length) truncated = true;
      }
      return {
        index: input.slide_index === undefined ? relativeIndex : input.slide_index,
        texts,
      };
    });
    return {
      status: "ok",
      item: itemReference(item),
      slides: boundedSlides,
      truncated,
    };
  }

  async replaceTextFile(input: ReplaceTextFileInput): Promise<{ status: "updated"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(input.item_id, { allowRoot: false });
    this.assertMime(item, TEXT_MIMES);
    const updated = await this.uploadText({}, input.content, item.mimeType, "PATCH", item);
    return { status: "updated", item: itemReference(updated) };
  }

  async updateGoogleDoc(input: UpdateGoogleDocInput): Promise<{ status: "updated"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(input.document_id, { allowRoot: false });
    this.assertMime(item, DOC_MIME);
    await this.replaceDocument(item.id, input.content);
    return { status: "updated", item: itemReference(item) };
  }

  async updateGoogleSheet(input: UpdateGoogleSheetInput): Promise<{ status: "updated"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(input.spreadsheet_id, { allowRoot: false });
    this.assertMime(item, SHEET_MIME);
    await this.writeSheet(item.id, input.range, input.values, input.value_input_option);
    return { status: "updated", item: itemReference(item) };
  }

  async updateGooglePresentation(input: UpdateGooglePresentationInput): Promise<{ status: "updated"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(input.presentation_id, { allowRoot: false });
    this.assertMime(item, PRESENTATION_MIME);
    await this.replacePresentation(item.id, input.slides);
    return { status: "updated", item: itemReference(item) };
  }

  async renameItem(input: RenameItemInput): Promise<{ status: "renamed"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(input.item_id, { allowRoot: false });
    const result = await this.writeJson(
      `${DRIVE_API}/files/${encodePathPart(item.id)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
      "PATCH",
      { name: input.new_name },
    );
    const renamed = parseWriteResult(() =>
      assertDriveFilePostcondition(asDriveFile(result), {
        id: item.id,
        name: input.new_name,
        mimeType: item.mimeType,
        ...(item.parents?.[0] === undefined ? {} : { parentId: item.parents[0] }),
        trashed: false,
      }),
    );
    return { status: "renamed", item: itemReference(renamed) };
  }

  async moveItem(itemId: string, destinationFolderId: string): Promise<{ status: "moved"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(itemId, { allowRoot: false });
    const destination = await this.managedParent(destinationFolderId, false);
    if (item.id === destination.id) throw new GoogleDriveMcpError("invalid_input");
    if (item.mimeType === FOLDER_MIME && (await this.isDescendantOf(destination.id, item.id))) {
      throw new GoogleDriveMcpError("invalid_input");
    }
    const query = new URLSearchParams({ addParents: destination.id, fields: FILE_FIELDS });
    if ((item.parents ?? []).length > 0) query.set("removeParents", (item.parents ?? []).join(","));
    const result = await this.writeJson(`${DRIVE_API}/files/${encodePathPart(item.id)}?${query}`, "PATCH", {});
    const moved = parseWriteResult(() =>
      assertDriveFilePostcondition(asDriveFile(result), {
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        parentId: destination.id,
        trashed: false,
      }),
    );
    return { status: "moved", item: itemReference(moved) };
  }

  async copyItem(input: CopyItemInput): Promise<{ status: "copied"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(input.item_id, { allowRoot: false });
    if (item.mimeType === FOLDER_MIME) throw new GoogleDriveMcpError("invalid_input");
    const parent = await this.managedParent(input.destination_folder_id, false);
    const result = await this.writeJson(
      `${DRIVE_API}/files/${encodePathPart(item.id)}/copy?fields=${encodeURIComponent(FILE_FIELDS)}`,
      "POST",
      {
        parents: [parent.id],
        ...(input.new_name === undefined ? {} : { name: input.new_name }),
      },
    );
    const copied = parseWriteResult(() =>
      assertDriveFilePostcondition(asDriveFile(result), {
        differentFromId: item.id,
        name: input.new_name ?? item.name,
        mimeType: item.mimeType,
        parentId: parent.id,
        trashed: false,
      }),
    );
    return { status: "copied", item: itemReference(copied) };
  }

  async trashItem(itemId: string): Promise<{ status: "trashed"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(itemId, { allowRoot: false });
    const result = await this.writeJson(
      `${DRIVE_API}/files/${encodePathPart(item.id)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
      "PATCH",
      { trashed: true },
    );
    const trashed = parseWriteResult(() =>
      assertDriveFilePostcondition(asDriveFile(result), { id: item.id, trashed: true }),
    );
    return { status: "trashed", item: itemReference(trashed) };
  }

  async restoreItem(itemId: string): Promise<{ status: "restored"; item: ItemReference }> {
    const { item } = await this.assertInsideWorkspace(itemId, { allowRoot: false });
    const result = await this.writeJson(
      `${DRIVE_API}/files/${encodePathPart(item.id)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
      "PATCH",
      { trashed: false },
    );
    const restored = parseWriteResult(() =>
      assertDriveFilePostcondition(asDriveFile(result), { id: item.id, trashed: false }),
    );
    return { status: "restored", item: itemReference(restored) };
  }

  private permissionReference(permission: JsonRecord): PermissionReference {
    if (typeof permission.id !== "string" || typeof permission.type !== "string" || typeof permission.role !== "string") {
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
    return {
      id: permission.id,
      type: permission.type,
      role: permission.role,
      email: typeof permission.emailAddress === "string" ? permission.emailAddress : null,
      domain: typeof permission.domain === "string" ? permission.domain : null,
    };
  }

  async listItemPermissions(input: ListItemPermissionsInput): Promise<{ status: "ok"; permissions: PermissionReference[]; next_cursor: string | null }> {
    await this.assertInsideWorkspace(input.item_id);
    const query = new URLSearchParams({
      fields: "nextPageToken,permissions(id,type,role,emailAddress,domain)",
      pageSize: String(input.page_size),
    });
    if (input.cursor !== undefined) query.set("pageToken", input.cursor);
    const result = asRecord(await this.readJson(`${DRIVE_API}/files/${encodePathPart(input.item_id)}/permissions?${query}`));
    if (!Array.isArray(result.permissions) || result.permissions.length > input.page_size) {
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
    if (
      result.nextPageToken !== undefined &&
      (typeof result.nextPageToken !== "string" ||
        result.nextPageToken.length === 0 ||
        result.nextPageToken.length > MAX_PAGE_TOKEN_LENGTH)
    ) {
      throw new GoogleDriveMcpError("provider_invalid_response");
    }
    const permissions = result.permissions.map((permission) => this.permissionReference(asRecord(permission)));
    return {
      status: "ok",
      permissions,
      next_cursor: typeof result.nextPageToken === "string" ? result.nextPageToken : null,
    };
  }

  async removeItemPermission(input: RemoveItemPermissionInput): Promise<{ status: "permission_removed"; item_id: string; permission_id: string }> {
    await this.assertInsideWorkspace(input.item_id, { allowRoot: false });
    const query = new URLSearchParams({ fields: "id,type,role,emailAddress,domain" });
    const target = this.permissionReference(
      asRecord(
        await this.readJson(
          `${DRIVE_API}/files/${encodePathPart(input.item_id)}/permissions/${encodePathPart(input.permission_id)}?${query}`,
        ),
      ),
    );
    if (target.role === "owner") throw new GoogleDriveMcpError("invalid_input");
    await this.deleteWrite(
      `${DRIVE_API}/files/${encodePathPart(input.item_id)}/permissions/${encodePathPart(input.permission_id)}`,
    );
    return { status: "permission_removed", item_id: input.item_id, permission_id: input.permission_id };
  }
}
