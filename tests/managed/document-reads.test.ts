import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { DOCUMENT_FORMATS, extractDocumentText, MAX_DOCUMENT_BYTES } from "../../src/managedFileExtraction.js";
import { toToolError } from "../../src/managedErrors.js";
import { GoogleDriveClient } from "../../src/managedWorkspace.js";
import { createManagedMcpServer } from "../../src/managedServer.js";
import type { FetchLike } from "../../src/managedWorkspace.js";
import { officeFixture, pdfFixture } from "./document-fixtures.js";

function fixtureClient(mime: string, bytes: Uint8Array) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const state = { authorized: true, canDownload: true, media: () => new Response(new Uint8Array(bytes)) };
  const fetcher: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      expect(init?.method ?? "GET").toBe("GET");
      if (url.pathname === "/drive/v3/files") return Response.json({ files: [] });
      expect(url.pathname).toBe("/drive/v3/files/approved_file");
      if (url.searchParams.get("alt") === "media") return state.media();
      if (!state.authorized) return Response.json({}, { status: 404 });
      return Response.json({ id: "approved_file", name: "Approved fixture", mimeType: mime, trashed: false, parents: [], capabilities: { canDownload: state.canDownload } });
    };
  const client = new GoogleDriveClient("test-bearer-never-print", { fetch: fetcher, sleep: async () => {} });
  return { client, state, calls, fetcher };
}

describe("bounded binary document reads", () => {
  it.each([...DOCUMENT_FORMATS])("reads real content for %s", async (mime, format) => {
    const bytes = format === "pdf" ? await pdfFixture() : await officeFixture(format);
    const { client, calls } = fixtureClient(mime, bytes);
    const result = await client.readTextFile({ item_id: "approved_file", offset: 0, limit: 2000 });
    expect(result.status).toBe("ok");
    expect(result.text).toContain(format === "pdf" ? "Authorized PDF content" : "Authorized document content");
    expect(result.next_offset).toBeNull();
    const media = calls.find((call) => call.url.searchParams.get("alt") === "media")!;
    expect(media.init?.redirect).toBe("error");
    expect(media.init?.signal).toBeInstanceOf(AbortSignal);
  }, 15_000);

  it.each([...DOCUMENT_FORMATS])("returns extracted %s content through MCP", async (mime, format) => {
    const { fetcher } = fixtureClient(mime, format === "pdf" ? await pdfFixture() : await officeFixture(format));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createManagedMcpServer({ bearer: "test-bearer-never-print", fetch: fetcher });
    const client = new Client({ name: "document-read-tests", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "read_text_file", arguments: { item_id: "approved_file", offset: 0, limit: 2000 } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "ok", text: expect.stringContaining(format === "pdf" ? "Authorized PDF content" : "Authorized document content"), next_offset: null });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
    } finally {
      await client.close();
      await server.close();
    }
  }, 15_000);

  it.each(["text/plain", "text/markdown", "text/csv"])("preserves existing %s reads", async (mime) => {
    const { client } = fixtureClient(mime, Buffer.from("plain,approved\ntext"));
    expect(await client.readTextFile({ item_id: "approved_file", offset: 0, limit: 2000 })).toMatchObject({ text: "plain,approved\ntext", next_offset: null });
  });

  it("paginates extracted text and rechecks authorization on every page", async () => {
    const { client, state, calls } = fixtureClient("application/pdf", await pdfFixture());
    const first = await client.readTextFile({ item_id: "approved_file", offset: 0, limit: 10 });
    const second = await client.readTextFile({ item_id: "approved_file", offset: first.next_offset!, limit: 2000 });
    expect(first.text + second.text).toContain("Authorized PDF content");
    state.authorized = false;
    await expect(client.readTextFile({ item_id: "approved_file", offset: 10, limit: 10 })).rejects.toMatchObject({ code: "DRIVE_ITEM_NOT_AUTHORIZED" });
    expect(calls.filter((call) => call.url.searchParams.get("alt") === "media")).toHaveLength(2);
  });

  it("does not download when the user lacks download permission", async () => {
    const { client, state, calls } = fixtureClient("application/pdf", await pdfFixture());
    state.canDownload = false;
    await expect(client.readTextFile({ item_id: "approved_file", offset: 0, limit: 10 })).rejects.toMatchObject({ code: "DRIVE_CAPABILITY_DENIED" });
    expect(calls.some((call) => call.url.searchParams.has("alt"))).toBe(false);
  });

  it.each(["application/zip", "image/png", "application/msword", "application/octet-stream"])("rejects unsupported %s without downloading", async (mime) => {
    const { client, calls } = fixtureClient(mime, new Uint8Array());
    await expect(client.readTextFile({ item_id: "approved_file", offset: 0, limit: 10 })).rejects.toMatchObject({ code: "DRIVE_ITEM_TYPE_UNSUPPORTED" });
    expect(calls.some((call) => call.url.searchParams.has("alt"))).toBe(false);
  });

  it("rejects truncated media instead of treating partial text as a full document", async () => {
    const { client, state } = fixtureClient("application/pdf", await pdfFixture());
    state.media = () => new Response("%PDF", { status: 206, headers: { "Content-Range": "bytes 0-3/1000" } });
    await expect(client.readTextFile({ item_id: "approved_file", offset: 0, limit: 10 })).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });

  it("rejects oversized downloads before parsing", async () => {
    const { client, state } = fixtureClient("application/pdf", new Uint8Array());
    state.media = () => new Response("x", { headers: { "Content-Length": String(MAX_DOCUMENT_BYTES + 1) } });
    await expect(client.readTextFile({ item_id: "approved_file", offset: 0, limit: 10 })).rejects.toMatchObject({ code: "DOCUMENT_LIMIT_EXCEEDED" });
    await expect(extractDocumentText(new Uint8Array(MAX_DOCUMENT_BYTES + 1), "application/pdf")).rejects.toMatchObject({ code: "DOCUMENT_LIMIT_EXCEEDED" });
  });

  it("reports blank/image-only PDFs as no extractable text, not successful reading", async () => {
    await expect(extractDocumentText(await pdfFixture(""), "application/pdf")).rejects.toMatchObject({ code: "DOCUMENT_NO_EXTRACTABLE_TEXT" });
  });

  it.each([...DOCUMENT_FORMATS])("sanitizes malformed %s errors", async (mime) => {
    try {
      await extractDocumentText(Buffer.from("private contents test-bearer-never-print"), mime);
      expect.fail("malformed document unexpectedly accepted");
    } catch (error) {
      const result = JSON.stringify(toToolError(error));
      expect(result).toContain("DOCUMENT_EXTRACTION_FAILED");
      expect(result).not.toContain("private contents");
      expect(result).not.toContain("test-bearer-never-print");
    }
  });

  it("rejects oversized extracted text rather than silently truncating", async () => {
    await expect(extractDocumentText(await officeFixture("docx", "x".repeat(100_001)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toMatchObject({ code: "DOCUMENT_LIMIT_EXCEEDED" });
  });

  it("rejects ZIP entry bombs before extraction", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2050; index += 1) zip.file(`entry${index}`, "x");
    await expect(extractDocumentText(await zip.generateAsync({ type: "uint8array" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toMatchObject({ code: "DOCUMENT_LIMIT_EXCEEDED" });
  });

  it("rejects compressed expansion bombs", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "x".repeat(33 * 1024 * 1024));
    await expect(extractDocumentText(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toMatchObject({ code: "DOCUMENT_LIMIT_EXCEEDED" });
  });

  it("reports password-required ODF containers without accepting a password", async () => {
    const zip = await JSZip.loadAsync(await officeFixture("odt"));
    zip.file("META-INF/manifest.xml", '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>');
    await expect(extractDocumentText(await zip.generateAsync({ type: "uint8array" }), "application/vnd.oasis.opendocument.text")).rejects.toMatchObject({ code: "DOCUMENT_ENCRYPTED" });
  });

  it("does not return successful partial text when a DOCX content part is missing", async () => {
    const zip = await JSZip.loadAsync(await officeFixture("docx"));
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replace("</w:body>", '<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="missing"/></w:body>'));
    await expect(extractDocumentText(await zip.generateAsync({ type: "uint8array" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toMatchObject({ code: "DOCUMENT_EXTRACTION_FAILED" });
  });

  it("rejects a MIME/container mismatch", async () => {
    await expect(extractDocumentText(await pdfFixture(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toMatchObject({ code: "DOCUMENT_EXTRACTION_FAILED" });
  });

  it("cancels a streaming response that exceeds the download cap", async () => {
    const { client, state } = fixtureClient("application/pdf", new Uint8Array());
    let cancelled = false;
    state.media = () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }));
    await expect(client.readTextFile({ item_id: "approved_file", offset: 0, limit: 10 })).rejects.toMatchObject({ code: "DOCUMENT_LIMIT_EXCEEDED" });
    expect(cancelled).toBe(true);
  });
});
