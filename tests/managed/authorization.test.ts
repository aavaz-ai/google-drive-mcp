import { describe, expect, it } from "vitest";

import {
  GoogleDriveClient,
  type FetchLike,
} from "../../src/managedWorkspace.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const PRESENTATION_MIME = "application/vnd.google-apps.presentation";

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

function driveFile(id: string, name: string, mimeType: string, capabilityOverrides: Record<string, boolean> = {}) {
  return {
    id,
    name,
    mimeType,
    parents: [],
    webViewLink: `https://drive.google.com/open?id=${id}`,
    createdTime: "2026-07-01T00:00:00.000Z",
    modifiedTime: "2026-07-01T00:00:00.000Z",
    trashed: false,
    capabilities: capabilities(capabilityOverrides),
  };
}

function requestParts(input: string | URL | Request, init?: RequestInit) {
  return { url: new URL(String(input)), method: init?.method ?? "GET" };
}

describe("direct drive.file authorization", () => {
  it("reads and updates Picker-authorized text, Docs, Sheets, and Slides without a managed workspace", async () => {
    const text = driveFile("picked_text", "picked.txt", "text/plain");
    const doc = driveFile("picked_doc", "Picked Doc", DOC_MIME);
    const sheet = driveFile("picked_sheet", "Picked Sheet", SHEET_MIME);
    const slides = driveFile("picked_slides", "Picked Slides", PRESENTATION_MIME);
    const files = new Map([text, doc, sheet, slides].map((file) => [file.id, file]));
    const driveUrls: URL[] = [];
    let writeCount = 0;
    const fetcher: FetchLike = async (input, init) => {
      const { url, method } = requestParts(input, init);
      if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files")) {
        driveUrls.push(url);
      }
      if (method === "GET" && url.pathname === "/drive/v3/files") {
        return Response.json({ files: [] });
      }
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        return new Response("picked text");
      }
      if (method === "GET" && url.pathname.startsWith("/drive/v3/files/")) {
        const id = url.pathname.split("/").at(-1) ?? "";
        const file = files.get(id);
        return file === undefined ? Response.json({}, { status: 404 }) : Response.json(file);
      }
      if (method === "PATCH" && url.pathname.startsWith("/upload/drive/v3/files/")) {
        writeCount += 1;
        return Response.json(text);
      }
      if (url.hostname === "docs.googleapis.com") {
        if (method === "GET") {
          return Response.json({
            tabs: [{ documentTab: { body: { content: [{ endIndex: 12, paragraph: { elements: [{ textRun: { content: "picked doc\n" } }] } }] } } }],
          });
        }
        writeCount += 1;
        return Response.json({ documentId: doc.id });
      }
      if (url.hostname === "sheets.googleapis.com") {
        if (method === "GET") return Response.json({ range: "Sheet1!A1", values: [["picked sheet"]] });
        writeCount += 1;
        return Response.json({
          spreadsheetId: sheet.id,
          updatedRange: "Sheet1!A1",
          updatedRows: 1,
          updatedColumns: 1,
          updatedCells: 1,
        });
      }
      if (url.hostname === "slides.googleapis.com") {
        if (method === "GET") {
          return Response.json({
            slides: [{ objectId: "picked_slide", pageElements: [{ shape: { text: { textElements: [{ textRun: { content: "picked slides\n" } }] } } }] }],
          });
        }
        writeCount += 1;
        return Response.json({ presentationId: slides.id });
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const client = new GoogleDriveClient("picker_bearer", { fetch: fetcher });

    await expect(client.readTextFile({ item_id: text.id, offset: 0, limit: 100 })).resolves.toMatchObject({ text: "picked text" });
    await expect(client.readGoogleDoc({ document_id: doc.id, offset: 0, limit: 100 })).resolves.toMatchObject({ text: "picked doc\n" });
    await expect(client.readGoogleSheet({ spreadsheet_id: sheet.id, range: "Sheet1!A1" })).resolves.toMatchObject({ values: [["picked sheet"]] });
    await expect(client.readGooglePresentation({ presentation_id: slides.id })).resolves.toMatchObject({ slides: [{ texts: ["picked slides"] }] });
    await expect(client.replaceTextFile({ item_id: text.id, content: "replacement" })).resolves.toMatchObject({ status: "updated" });
    await expect(client.updateGoogleDoc({ document_id: doc.id, content: "replacement" })).resolves.toMatchObject({ status: "updated" });
    await expect(client.updateGoogleSheet({
      spreadsheet_id: sheet.id,
      range: "Sheet1!A1",
      values: [["replacement"]],
      value_input_option: "RAW",
    })).resolves.toMatchObject({ status: "updated" });
    await expect(client.updateGooglePresentation({
      presentation_id: slides.id,
      slides: [{ title: "Replacement", body: "Body" }],
    })).resolves.toMatchObject({ status: "updated" });

    expect(writeCount).toBe(4);
    expect(driveUrls.length).toBeGreaterThan(0);
    expect(driveUrls.every((url) => url.searchParams.get("supportsAllDrives") === "true")).toBe(true);
    const requestedFields = driveUrls.find((url) => url.searchParams.has("fields"))?.searchParams.get("fields") ?? "";
    expect(requestedFields).toContain("copyRequiresWriterPermission");
    expect(requestedFields).toContain("downloadRestrictions");
    expect(requestedFields).toContain("canDownload");
    expect(requestedFields).toContain("canAddChildren");
  });

  it("lists and safely searches only bearer-visible items with bounded, server-built queries", async () => {
    const folder = driveFile("picked_folder", "Picked folder", FOLDER_MIME, { canAddChildren: true, canDownload: false });
    const doc = driveFile("picked_doc", "Quarter's \\ plan", DOC_MIME);
    const urls: URL[] = [];
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        const query = url.searchParams.get("q") ?? "";
        if (query.includes(`mimeType = '${FOLDER_MIME}'`)) {
          return Response.json({ files: [folder], nextPageToken: "next_page" });
        }
        if (query.includes("fullText")) return Response.json({ files: [doc] });
        throw new Error(`unexpected query ${query}`);
      },
    });

    await expect(client.listAuthorizedItems({ type: "folder", page_size: 10, cursor: "opaque_page" })).resolves.toMatchObject({
      items: [{ id: folder.id }],
      next_cursor: "next_page",
    });
    await expect(client.searchAuthorizedItems({ query: "Quarter's \\ plan", type: "doc", limit: 7 })).resolves.toMatchObject({
      items: [{ id: doc.id }],
      next_cursor: null,
    });

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

  it("organizes and manages permissions for directly authorized files while using an external folder only as a destination", async () => {
    const source = driveFile("picked_file", "Picked.txt", "text/plain");
    const destination = driveFile("picked_folder", "Picked folder", FOLDER_MIME, { canAddChildren: true, canDownload: false });
    const permission = {
      id: "permission_id",
      type: "user",
      role: "reader",
      emailAddress: "person@example.com",
    };
    const driveUrls: URL[] = [];
    let writeCount = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files")) driveUrls.push(url);
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [] });
        if (method === "GET" && url.pathname.endsWith("/permissions/permission_id")) return Response.json(permission);
        if (method === "GET" && url.pathname.endsWith("/permissions")) return Response.json({ permissions: [permission] });
        if (method === "GET" && url.pathname.endsWith(`/${source.id}`)) return Response.json(source);
        if (method === "GET" && url.pathname.endsWith(`/${destination.id}`)) return Response.json(destination);
        if (method === "POST" && url.pathname.endsWith("/copy")) {
          writeCount += 1;
          return Response.json({ ...driveFile("copied_file", "Copied.txt", "text/plain"), parents: [destination.id] });
        }
        if (method === "POST" && url.pathname.endsWith("/permissions")) {
          writeCount += 1;
          return Response.json(permission);
        }
        if (method === "DELETE" && url.pathname.endsWith("/permissions/permission_id")) {
          writeCount += 1;
          return new Response(null, { status: 204 });
        }
        if (method === "PATCH" && url.pathname.endsWith(`/${source.id}`)) {
          writeCount += 1;
          if (url.searchParams.has("addParents")) return Response.json({ ...source, parents: [destination.id] });
          const body = JSON.parse(String(init?.body)) as { name?: string; trashed?: boolean };
          if (body.name !== undefined) return Response.json({ ...source, name: body.name });
          if (body.trashed !== undefined) return Response.json({ ...source, trashed: body.trashed });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });

    await expect(client.getItemMetadata(destination.id)).resolves.toMatchObject({ item: { id: destination.id } });
    await expect(client.renameItem({ item_id: source.id, new_name: "Renamed.txt" })).resolves.toMatchObject({ status: "renamed" });
    await expect(client.moveItem(source.id, destination.id)).resolves.toMatchObject({ status: "moved" });
    await expect(client.copyItem({
      item_id: source.id,
      destination_folder_id: destination.id,
      new_name: "Copied.txt",
    })).resolves.toMatchObject({ status: "copied" });
    await expect(client.trashItem(source.id)).resolves.toMatchObject({ status: "trashed" });
    await expect(client.restoreItem(source.id)).resolves.toMatchObject({ status: "restored" });
    await expect(client.shareItem({
      item_id: source.id,
      recipient_type: "user",
      email: "person@example.com",
      role: "reader",
      send_notification: true,
    })).resolves.toMatchObject({ status: "shared" });
    await expect(client.listItemPermissions({ item_id: source.id, page_size: 50 })).resolves.toMatchObject({
      permissions: [{ id: permission.id }],
    });
    await expect(client.removeItemPermission({ item_id: source.id, permission_id: permission.id })).resolves.toMatchObject({
      status: "permission_removed",
    });

    expect(writeCount).toBe(7);
    expect(driveUrls.length).toBeGreaterThan(0);
    expect(driveUrls.every((url) => url.searchParams.get("supportsAllDrives") === "true")).toBe(true);
  });

  it("fails closed for unpicked items and parents, then distinguishes a post-authorization 404", async () => {
    const doc = driveFile("picked_doc", "Picked Doc", DOC_MIME);
    let providerCalls = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input) => {
        providerCalls += 1;
        const url = new URL(String(input));
        if (url.pathname.endsWith("/unpicked_id") || url.pathname.endsWith("/unpicked_parent")) {
          return Response.json({ provider_body: "must-not-surface" }, { status: 404 });
        }
        if (url.hostname === "www.googleapis.com" && url.pathname.endsWith(`/${doc.id}`)) return Response.json(doc);
        if (url.pathname === "/drive/v3/files") return Response.json({ files: [] });
        if (url.hostname === "docs.googleapis.com") return Response.json({}, { status: 404 });
        throw new Error(`unexpected ${url}`);
      },
    });

    await expect(client.getItemMetadata("unpicked_id")).rejects.toMatchObject({ code: "DRIVE_ITEM_NOT_AUTHORIZED" });
    await expect(client.createFolder({ name: "Blocked", parent_id: "unpicked_parent" })).rejects.toMatchObject({
      code: "DRIVE_PARENT_NOT_AUTHORIZED",
    });
    await expect(client.readGoogleDoc({ document_id: doc.id, offset: 0, limit: 10 })).rejects.toMatchObject({
      code: "DRIVE_ITEM_NOT_FOUND",
    });
    expect(providerCalls).toBe(5);
  });

  it("denies missing capabilities and external-folder mutations before writes", async () => {
    const restrictedText = {
      ...driveFile("restricted_text", "Restricted.txt", "text/plain", { canDownload: false }),
      downloadRestrictions: {
        effectiveDownloadRestrictionWithContext: { restrictedForReaders: true, restrictedForWriters: false },
      },
    };
    const restrictedDoc = driveFile("restricted_doc", "Restricted Doc", DOC_MIME, { canEdit: false });
    const restrictedCopy = {
      ...driveFile("restricted_copy", "Restricted copy.txt", "text/plain", { canCopy: false }),
      copyRequiresWriterPermission: true,
    };
    const externalFolder = driveFile("external_folder", "External folder", FOLDER_MIME, { canAddChildren: false, canDownload: false });
    const files = new Map([restrictedText, restrictedDoc, restrictedCopy, externalFolder].map((file) => [file.id, file]));
    let writes = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method !== "GET") writes += 1;
        if (url.pathname === "/drive/v3/files") return Response.json({ files: [] });
        if (url.pathname.startsWith("/drive/v3/files/")) {
          const file = files.get(url.pathname.split("/").at(-1) ?? "");
          return file === undefined ? Response.json({}, { status: 404 }) : Response.json(file);
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });

    await expect(client.readTextFile({ item_id: restrictedText.id, offset: 0, limit: 10 })).rejects.toMatchObject({
      code: "DRIVE_CAPABILITY_DENIED",
    });
    await expect(client.updateGoogleDoc({ document_id: restrictedDoc.id, content: "blocked" })).rejects.toMatchObject({
      code: "DRIVE_CAPABILITY_DENIED",
    });
    await expect(client.copyItem({ item_id: restrictedCopy.id })).rejects.toMatchObject({
      code: "DRIVE_CAPABILITY_DENIED",
    });
    await expect(client.createFolder({ name: "Blocked", parent_id: externalFolder.id })).rejects.toMatchObject({
      code: "DRIVE_CAPABILITY_DENIED",
    });
    await expect(client.renameItem({ item_id: externalFolder.id, new_name: "Blocked rename" })).rejects.toMatchObject({
      code: "DRIVE_ITEM_TYPE_UNSUPPORTED",
    });
    await expect(client.listWorkspaceItems({ parent_id: externalFolder.id, page_size: 50 })).rejects.toMatchObject({
      code: "DRIVE_PARENT_NOT_AUTHORIZED",
    });
    expect(writes).toBe(0);
  });
});
