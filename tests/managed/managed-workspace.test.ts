import { describe, expect, it } from "vitest";

import type { GoogleDriveMcpError } from "../../src/managedErrors.js";
import {
  GoogleDriveClient,
  WORKSPACE_DESCRIPTION,
  type FetchLike,
} from "../../src/managedWorkspace.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function driveFile(
  id: string,
  name: string,
  parents: string[] = [],
  mimeType = FOLDER_MIME,
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
    description: name === "Enterpret" ? WORKSPACE_DESCRIPTION : undefined,
  };
}

function requestParts(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input));
  return { url, method: init?.method ?? "GET" };
}

describe("managed workspace", () => {
  it("survives fresh stateless clients and creates the marked folder only once", async () => {
    let workspace: ReturnType<typeof driveFile> | null = null;
    let createCalls = 0;
    const fetcher: FetchLike = async (input, init) => {
      const { url, method } = requestParts(input, init);
      if (method === "GET" && url.pathname === "/drive/v3/files") {
        return Response.json({ files: workspace === null ? [] : [workspace] });
      }
      if (method === "POST" && url.pathname === "/drive/v3/files") {
        createCalls += 1;
        const metadata = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(metadata).toMatchObject({ name: "Enterpret", mimeType: FOLDER_MIME, description: WORKSPACE_DESCRIPTION });
        workspace = driveFile("workspace_id", "Enterpret");
        return Response.json(workspace);
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    };

    const first = await new GoogleDriveClient("bearer", { fetch: fetcher }).ensureWorkspace();
    const second = await new GoogleDriveClient("bearer", { fetch: fetcher }).ensureWorkspace();

    expect(first).toMatchObject({ status: "created", workspace: { id: "workspace_id" } });
    expect(second).toMatchObject({ status: "found", workspace: { id: "workspace_id" } });
    expect(createCalls).toBe(1);
  });

  it("does not create a missing workspace from a read-only tool", async () => {
    let writes = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (_input, init) => {
        if ((init?.method ?? "GET") !== "GET") writes += 1;
        return Response.json({ files: [] });
      },
    });

    await expect(client.listWorkspaceItems({ page_size: 50 })).rejects.toMatchObject({
      code: "workspace_not_initialized",
    });
    expect(writes).toBe(0);
  });

  it("fails closed before sharing an outside-workspace item", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    let permissionWrites = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (method === "GET" && url.pathname.endsWith("/outside_id")) return Response.json(driveFile("outside_id", "Outside", ["other_root"], "text/plain"));
        if (method === "GET" && url.pathname.endsWith("/other_root")) return Response.json(driveFile("other_root", "Other root"));
        if (url.pathname.endsWith("/permissions")) permissionWrites += 1;
        throw new Error(`unexpected ${method} ${url.pathname}`);
      },
    });

    await expect(
      client.shareItem({
        item_id: "outside_id",
        recipient_type: "user",
        email: "person@example.com",
        role: "reader",
        send_notification: true,
      }),
    ).rejects.toMatchObject({ code: "outside_workspace" });
    expect(permissionWrites).toBe(0);
  });

  it("fails closed before creating under an outside-workspace parent", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    let writes = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method !== "GET") writes += 1;
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (method === "GET" && url.pathname.endsWith("/outside_folder")) return Response.json(driveFile("outside_folder", "Outside", ["other_root"]));
        if (method === "GET" && url.pathname.endsWith("/other_root")) return Response.json(driveFile("other_root", "Other root"));
        throw new Error(`unexpected ${method} ${url.pathname}`);
      },
    });

    await expect(client.createFolder({ name: "Blocked", parent_id: "outside_folder" })).rejects.toMatchObject({
      code: "outside_workspace",
    });
    expect(writes).toBe(0);
  });

  it("fails closed before moving a folder into any of its descendants", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    const files = new Map([
      ["folder_a", driveFile("folder_a", "A", [workspace.id])],
      ["folder_b", driveFile("folder_b", "B", ["folder_a"])],
    ]);
    let writes = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method !== "GET") writes += 1;
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (method === "GET" && url.pathname.startsWith("/drive/v3/files/")) {
          const id = url.pathname.split("/").at(-1) ?? "";
          const file = files.get(id);
          return file === undefined ? Response.json({}, { status: 404 }) : Response.json(file);
        }
        throw new Error(`unexpected ${method} ${url.pathname}`);
      },
    });

    await expect(client.moveItem("folder_a", "folder_b")).rejects.toMatchObject({ code: "invalid_input" });
    expect(writes).toBe(0);
  });

  it("selects duplicate active workspaces deterministically by creation time then ID", async () => {
    const newer = { ...driveFile("workspace_z", "Enterpret"), createdTime: "2026-07-02T00:00:00.000Z" };
    const earlierB = { ...driveFile("workspace_b", "Enterpret"), createdTime: "2026-07-01T00:00:00.000Z" };
    const earlierA = { ...driveFile("workspace_a", "Enterpret"), createdTime: "2026-07-01T00:00:00.000Z" };
    const client = new GoogleDriveClient("bearer", {
      fetch: async () => Response.json({ files: [newer, earlierB, earlierA] }),
    });

    await expect(client.ensureWorkspace()).resolves.toMatchObject({ status: "found", workspace: { id: "workspace_a" } });
  });
});

describe("provider safety", () => {
  it("classifies malformed read responses without implying an ambiguous write", async () => {
    const client = new GoogleDriveClient("bearer", {
      fetch: async () => new Response("not-json", { status: 200 }),
    });

    await expect(client.ensureWorkspace()).rejects.toMatchObject({
      code: "provider_invalid_response",
      outcome: "not_completed",
    });
  });

  it("retries bounded read failures but not beyond the configured attempts", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async () => {
        calls += 1;
        if (calls < 3) return Response.json({ provider_secret: "must-not-surface" }, { status: 503 });
        return Response.json({ files: [driveFile("workspace_id", "Enterpret")] });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(client.ensureWorkspace()).resolves.toMatchObject({ status: "found" });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 300]);
  });

  it("does not retry an ambiguous write failure", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    let writeCalls = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (method === "GET" && url.pathname.endsWith("/workspace_id")) return Response.json(workspace);
        if (method === "POST" && url.pathname === "/drive/v3/files") {
          writeCalls += 1;
          return Response.json({ provider_secret: "must-not-surface" }, { status: 503 });
        }
        throw new Error(`unexpected ${method} ${url.pathname}`);
      },
      sleep: async () => undefined,
    });

    await expect(client.createFolder({ name: "Report", parent_id: undefined })).rejects.toMatchObject({
      code: "write_unknown_outcome",
      outcome: "unknown",
      providerStatus: 503,
    } satisfies Partial<GoogleDriveMcpError>);
    expect(writeCalls).toBe(1);
  });

  it("marks a failed content population as unknown after native file creation", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    let fileCreates = 0;
    let contentWrites = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (method === "GET" && url.pathname.endsWith("/workspace_id")) return Response.json(workspace);
        if (method === "POST" && url.pathname === "/drive/v3/files") {
          fileCreates += 1;
          return Response.json(
            driveFile("doc_id", "Report", [workspace.id], "application/vnd.google-apps.document"),
          );
        }
        if (method === "POST" && url.hostname === "docs.googleapis.com") {
          contentWrites += 1;
          return Response.json({ provider_secret: "must-not-surface" }, { status: 400 });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });

    await expect(
      client.createGoogleDoc({ name: "Report", content: "Body", parent_id: undefined }),
    ).rejects.toMatchObject({
      code: "write_unknown_outcome",
      outcome: "unknown",
      providerStatus: 400,
    });
    expect(fileCreates).toBe(1);
    expect(contentWrites).toBe(1);
  });
});

describe("Google content adapters", () => {
  it("uploads text with Google's multipart/related wire format", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    let upload: RequestInit | undefined;
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (method === "GET" && url.pathname.endsWith("/workspace_id")) return Response.json(workspace);
        if (method === "POST" && url.hostname === "www.googleapis.com" && url.pathname === "/upload/drive/v3/files") {
          upload = init;
          return Response.json(driveFile("text_id", "report.md", [workspace.id], "text/markdown"));
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });

    await client.createTextFile({
      name: "report.md",
      content: "# Results\nUnicode: ✓",
      mime_type: "text/markdown",
      parent_id: undefined,
    });

    const headers = new Headers(upload?.headers);
    expect(headers.get("Content-Type")).toMatch(/^multipart\/related; boundary=enterpret_[a-f0-9]{32}$/u);
    expect(Buffer.isBuffer(upload?.body)).toBe(true);
    const body = (upload?.body as Buffer).toString("utf8");
    expect(body).toContain('"name":"report.md"');
    expect(body).toContain("Content-Type: text/markdown; charset=UTF-8");
    expect(body).toContain("# Results\nUnicode: ✓");
  });

  it("creates and populates bounded Docs, Sheets, and Slides through their dedicated APIs", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    const files = new Map<string, ReturnType<typeof driveFile>>([[workspace.id, workspace]]);
    const writes: Array<{ url: URL; body: unknown }> = [];
    const fetcher: FetchLike = async (input, init) => {
      const { url, method } = requestParts(input, init);
      if (method === "GET" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
      if (method === "GET" && url.pathname.startsWith("/drive/v3/files/")) {
        const id = url.pathname.split("/").at(-1) ?? "";
        const item = files.get(id);
        return item === undefined ? Response.json({}, { status: 404 }) : Response.json(item);
      }
      if (method === "POST" && url.pathname === "/drive/v3/files") {
        const body = JSON.parse(String(init?.body)) as { mimeType: string; name: string; parents: string[] };
        const idByMime: Record<string, string> = {
          "application/vnd.google-apps.document": "doc_id",
          "application/vnd.google-apps.spreadsheet": "sheet_id",
          "application/vnd.google-apps.presentation": "slides_id",
        };
        const created = driveFile(idByMime[body.mimeType] ?? "unknown_id", body.name, body.parents, body.mimeType);
        files.set(created.id, created);
        return Response.json(created);
      }
      if (method === "GET" && url.hostname === "slides.googleapis.com") {
        return Response.json({ slides: [{ objectId: "existing_slide" }] });
      }
      if (method === "POST" || method === "PUT") {
        writes.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        if (url.hostname === "docs.googleapis.com") return Response.json({ documentId: "doc_id" });
        if (url.hostname === "sheets.googleapis.com") {
          return Response.json({
            spreadsheetId: "sheet_id",
            updatedRange: "Metrics!A1:B2",
            updatedRows: 2,
            updatedColumns: 2,
            updatedCells: 4,
          });
        }
        if (url.hostname === "slides.googleapis.com") return Response.json({ presentationId: "slides_id" });
        throw new Error(`unexpected write ${url}`);
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const client = new GoogleDriveClient("bearer", { fetch: fetcher });

    await client.createGoogleDoc({ name: "Report", content: "Hello doc", parent_id: undefined });
    await client.createGoogleSheet({
      name: "Metrics",
      values: [["Metric", "Value"], ["NPS", 42]],
      value_input_option: "RAW",
      parent_id: undefined,
    });
    await client.createGooglePresentation({
      name: "Review",
      slides: [{ title: "Summary", body: "What changed" }],
      parent_id: undefined,
    });

    const docsWrite = writes.find((write) => write.url.hostname === "docs.googleapis.com");
    expect(docsWrite?.url.pathname).toBe("/v1/documents/doc_id:batchUpdate");
    expect(docsWrite?.body).toMatchObject({ requests: [{ insertText: { text: "Hello doc" } }] });
    const sheetWrite = writes.find((write) => write.url.hostname === "sheets.googleapis.com");
    expect(sheetWrite?.url.pathname).toBe("/v4/spreadsheets/sheet_id/values/A1");
    expect(sheetWrite?.body).toMatchObject({ values: [["Metric", "Value"], ["NPS", 42]] });
    const slidesWrite = writes.find((write) => write.url.hostname === "slides.googleapis.com");
    expect(slidesWrite?.url.pathname).toBe("/v1/presentations/slides_id:batchUpdate");
    expect(slidesWrite?.body).toMatchObject({
      requests: expect.arrayContaining([
        { deleteObject: { objectId: "existing_slide" } },
        expect.objectContaining({
          createSlide: expect.objectContaining({
            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
          }),
        }),
      ]),
    });
  });

  it("reads bounded content from Docs, Sheets, and Slides after workspace ancestry checks", async () => {
    const workspace = driveFile("workspace_id", "Enterpret");
    const contentFiles = new Map([
      ["doc_id", driveFile("doc_id", "Report", [workspace.id], "application/vnd.google-apps.document")],
      ["sheet_id", driveFile("sheet_id", "Metrics", [workspace.id], "application/vnd.google-apps.spreadsheet")],
      ["slides_id", driveFile("slides_id", "Review", [workspace.id], "application/vnd.google-apps.presentation")],
    ]);
    const client = new GoogleDriveClient("bearer", {
      fetch: async (input, init) => {
        const { url, method } = requestParts(input, init);
        expect(method).toBe("GET");
        if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") return Response.json({ files: [workspace] });
        if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
          const id = url.pathname.split("/").at(-1) ?? "";
          return Response.json(contentFiles.get(id));
        }
        if (url.hostname === "docs.googleapis.com") {
          expect(url.searchParams.get("includeTabsContent")).toBe("true");
          return Response.json({
            tabs: [{
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: "Hello document\n" } }] } }] },
              },
            }],
          });
        }
        if (url.hostname === "sheets.googleapis.com") {
          return Response.json({ range: "Sheet1!A1:B2", values: [["Metric", "Value"], ["NPS", 42]] });
        }
        if (url.hostname === "slides.googleapis.com") {
          return Response.json({ slides: [{ pageElements: [{ shape: { text: { textElements: [{ textRun: { content: "Summary\n" } }] } } }] }] });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });

    await expect(client.readGoogleDoc({ document_id: "doc_id", offset: 0, limit: 5 })).resolves.toMatchObject({
      text: "Hello",
      next_offset: 5,
    });
    await expect(client.readGoogleSheet({ spreadsheet_id: "sheet_id", range: "Sheet1!A1:B2" })).resolves.toMatchObject({
      values: [["Metric", "Value"], ["NPS", 42]],
    });
    await expect(client.readGooglePresentation({ presentation_id: "slides_id" })).resolves.toMatchObject({
      slides: [{ index: 0, texts: ["Summary"] }],
    });
  });
});
