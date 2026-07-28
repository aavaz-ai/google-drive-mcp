import { describe, expect, it } from "vitest";

import { handleTool } from "../../src/tools/managed.js";
import {
  MAX_SHEET_CELLS,
  readGoogleSheetSchema,
  sheetReadResultSchema,
  sheetReadValuesSchema,
  sheetValuesSchema,
} from "../../src/tools/managedSchemas.js";
import {
  GoogleDriveClient,
  WORKSPACE_DESCRIPTION,
  type FetchLike,
} from "../../src/managedWorkspace.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

const workspace = {
  id: "workspace_id",
  name: "Enterpret",
  mimeType: FOLDER_MIME,
  parents: [],
  createdTime: "2026-07-01T00:00:00.000Z",
  trashed: false,
  description: WORKSPACE_DESCRIPTION,
};

const sheet = {
  id: "sheet_id",
  name: "Metrics",
  mimeType: SHEET_MIME,
  parents: [workspace.id],
  trashed: false,
  capabilities: { canDownload: true },
};

const itemReference = {
  id: sheet.id,
  name: sheet.name,
  mime_type: sheet.mimeType,
  parent_ids: sheet.parents,
  web_view_link: null,
  created_time: null,
  modified_time: null,
  trashed: false,
};

function sheetFetcher(
  readSheet: (range: string) => Response,
  onSheetRead?: () => void,
): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
      return Response.json({ files: [workspace] });
    }
    if (method === "GET" && url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${sheet.id}`) {
      return Response.json(sheet);
    }
    if (method === "GET" && url.hostname === "sheets.googleapis.com") {
      onSheetRead?.();
      return readSheet(decodeURIComponent(url.pathname.split("/values/")[1] ?? ""));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

describe("managed Google Sheets reads", () => {
  it("accepts bounded provider-native sparse values while write values remain rectangular", () => {
    const sparseValues = [["A", "B"], ["C"], []];

    expect(sheetReadValuesSchema.safeParse([]).success).toBe(true);
    expect(sheetReadValuesSchema.safeParse(sparseValues).success).toBe(true);
    expect(sheetValuesSchema.safeParse(sparseValues).success).toBe(false);
    expect(readGoogleSheetSchema.safeParse({ spreadsheet_id: sheet.id, range: "A1:Z100" }).success).toBe(true);
    expect(readGoogleSheetSchema.safeParse({ spreadsheet_id: sheet.id, range: "A1:A10000" }).success).toBe(true);
    expect(readGoogleSheetSchema.safeParse({ spreadsheet_id: sheet.id, range: "A1:A10001" }).success).toBe(false);
    expect(sheetReadResultSchema.safeParse({
      status: "ok",
      item: itemReference,
      range: "BLR!A1:Z100",
      values: sparseValues,
    }).success).toBe(true);
  });

  it("bounds read rows, row widths, actual cells, and aggregate text", () => {
    const oneCellRows = Array.from({ length: MAX_SHEET_CELLS }, () => [true]);
    const oneWideRow = [Array.from({ length: MAX_SHEET_CELLS }, () => true)];
    const maximumText = "x".repeat(10_000);

    expect(sheetReadValuesSchema.safeParse(oneCellRows).success).toBe(true);
    expect(sheetReadValuesSchema.safeParse([...oneCellRows, []]).success).toBe(false);
    expect(sheetReadValuesSchema.safeParse(oneWideRow).success).toBe(true);
    expect(sheetReadValuesSchema.safeParse([[...oneWideRow[0], true]]).success).toBe(false);
    expect(sheetReadValuesSchema.safeParse(Array.from({ length: 100 }, () => Array(100).fill(true))).success).toBe(true);
    expect(sheetReadValuesSchema.safeParse(Array.from({ length: 101 }, () => Array(100).fill(true))).success).toBe(false);
    expect(sheetReadValuesSchema.safeParse(Array.from({ length: 100 }, () => [maximumText])).success).toBe(true);
    expect(sheetReadValuesSchema.safeParse(Array.from({ length: 101 }, () => [maximumText])).success).toBe(false);
  });

  it("returns a wide sparse range unchanged without padding omitted rows or cells", async () => {
    const values = Array.from({ length: 46 }, (_, rowIndex) => {
      if (rowIndex === 20) return [];
      const width = rowIndex % 2 === 0 ? 26 : 5;
      return Array.from({ length: width }, (_value, columnIndex) => `${String(rowIndex)}:${String(columnIndex)}`);
    });
    let sheetReads = 0;
    const client = new GoogleDriveClient("bearer", {
      fetch: sheetFetcher(
        (range) => {
          expect(range).toBe("A1:Z100");
          return Response.json({ range: "BLR!A1:Z100", majorDimension: "ROWS", values });
        },
        () => {
          sheetReads += 1;
        },
      ),
    });

    await expect(client.readGoogleSheet({
      spreadsheet_id: sheet.id,
      range: "A1:Z100",
    })).resolves.toEqual({
      status: "ok",
      item: itemReference,
      range: "BLR!A1:Z100",
      values,
    });
    expect(sheetReads).toBe(1);
  });

  it("returns an empty array when Google omits values for an empty range", async () => {
    const client = new GoogleDriveClient("bearer", {
      fetch: sheetFetcher(() => Response.json({ range: "BLR!A1:Z100", majorDimension: "ROWS" })),
    });

    await expect(client.readGoogleSheet({
      spreadsheet_id: sheet.id,
      range: "A1:Z100",
    })).resolves.toMatchObject({
      range: "BLR!A1:Z100",
      values: [],
    });
  });

  it("keeps an invalid tab as a redacted non-retryable provider rejection", async () => {
    let sheetReads = 0;
    const client = new GoogleDriveClient("secret_bearer", {
      fetch: sheetFetcher(
        () => Response.json({ provider_secret: "GOOGLE_RESPONSE_BODY_MARKER" }, { status: 400 }),
        () => {
          sheetReads += 1;
        },
      ),
      sleep: async () => undefined,
    });

    const result = await handleTool(
      "read_google_sheet",
      { spreadsheet_id: sheet.id, range: "Sheet1!A1:Z100" },
      client,
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        status: "error",
        error: {
          code: "PROVIDER_REJECTED",
          outcome: "not_completed",
          retryable: false,
          provider_status: 400,
        },
      },
    });
    expect(sheetReads).toBe(1);
    expect(serialized).not.toContain("secret_bearer");
    expect(serialized).not.toContain("GOOGLE_RESPONSE_BODY_MARKER");
  });
});
