import { describe, expect, it } from "vitest";

import { MAX_TEXT_LENGTH } from "../../src/tools/managedSchemas.js";
import { GoogleDriveClient } from "../../src/managedWorkspace.js";

function body(text: string) {
  return { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] };
}

function tab(title: string, text: string) {
  return { tabProperties: { title }, documentTab: { body: body(text) } };
}

function fixture(document: unknown, options: { authorized?: boolean; canDownload?: boolean } = {}) {
  const calls: string[] = [];
  const client = new GoogleDriveClient("test_bearer", {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(init?.method ?? "GET").toBe("GET");
      calls.push(url.hostname);
      if (url.pathname === "/drive/v3/files") return Response.json({ files: [] });
      if (url.hostname === "www.googleapis.com") {
        if (options.authorized === false) return Response.json({}, { status: 404 });
        return Response.json({
          id: "picked_doc", name: "FDE sync", mimeType: "application/vnd.google-apps.document",
          parents: [], trashed: false, capabilities: { canDownload: options.canDownload ?? true },
        });
      }
      expect(url.hostname).toBe("docs.googleapis.com");
      expect(url.searchParams.get("includeTabsContent")).toBe("true");
      return Response.json(document);
    },
  });
  return { client, calls };
}

describe("authorized Google Docs content reads", () => {
  it("reads Notes, nested tabs, and Transcript in document order across page boundaries", async () => {
    const { client } = fixture({ tabs: [
      { ...tab("Notes", "Decisions\n"), childTabs: [tab("Actions", "Follow up\n")] },
      tab("Transcript", "Discussion\n"),
    ] });
    const expected = "[Tab: Notes]\nDecisions\n\n[Tab: Actions]\nFollow up\n\n[Tab: Transcript]\nDiscussion\n";
    let offset = 0;
    let combined = "";
    for (let page = 0; page < expected.length; page += 1) {
      const result = await client.readGoogleDoc({ document_id: "picked_doc", offset, limit: 17 });
      expect(result.text.length).toBeLessThanOrEqual(17);
      combined += result.text;
      if (result.next_offset === null) break;
      expect(result.next_offset).toBe(offset + result.text.length);
      offset = result.next_offset;
    }
    expect(combined).toBe(expected);
    await expect(client.readGoogleDoc({ document_id: "picked_doc", offset: expected.length, limit: 17 }))
      .resolves.toMatchObject({ text: "", next_offset: null });
  });

  it.each([
    { body: body("Simple PRD\n") },
    { tabs: [tab("PRD", "Simple PRD\n")] },
  ])("preserves plain text for legacy and single-tab Docs", async (document) => {
    const { client } = fixture(document);
    await expect(client.readGoogleDoc({ document_id: "picked_doc", offset: 0, limit: 100 }))
      .resolves.toMatchObject({ text: "Simple PRD\n", next_offset: null });
  });

  it("keeps table text and labels empty tabs", async () => {
    const { client } = fixture({ tabs: [tab("Empty", ""), {
      tabProperties: { title: "Table" },
      documentTab: { body: { content: [{ table: { tableRows: [{ tableCells: [body("Cell\n")] }] } }] } },
    }] });
    await expect(client.readGoogleDoc({ document_id: "picked_doc", offset: 0, limit: 100 }))
      .resolves.toMatchObject({ text: "[Tab: Empty]\n\n[Tab: Table]\nCell\n", next_offset: null });
  });

  it.each([
    { tabs: [] },
    { tabs: "invalid" },
    { tabs: [{ ...tab("Notes", "ok"), childTabs: {} }] },
    { tabs: [tab("Notes", "ok"), { documentTab: { body: {} } }] },
  ])("rejects malformed tab responses rather than returning partial content", async (document) => {
    const { client } = fixture(document);
    await expect(client.readGoogleDoc({ document_id: "picked_doc", offset: 0, limit: 100 }))
      .rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });

  it("bounds combined tab text and labels, not each tab independently", async () => {
    const { client } = fixture({ tabs: [
      tab("Notes", "x".repeat(MAX_TEXT_LENGTH / 2)),
      tab("Transcript", "y".repeat(MAX_TEXT_LENGTH / 2)),
    ] });
    await expect(client.readGoogleDoc({ document_id: "picked_doc", offset: 0, limit: 100 }))
      .rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });

  it.each([
    { options: { authorized: false }, code: "DRIVE_ITEM_NOT_AUTHORIZED" },
    { options: { canDownload: false }, code: "DRIVE_CAPABILITY_DENIED" },
  ])("enforces $code before requesting any document content", async ({ options, code }) => {
    const { client, calls } = fixture({ tabs: [tab("Notes", "private"), tab("Transcript", "private")] }, options);
    await expect(client.readGoogleDoc({ document_id: "picked_doc", offset: 0, limit: 100 }))
      .rejects.toMatchObject({ code });
    expect(calls).not.toContain("docs.googleapis.com");
  });
});
