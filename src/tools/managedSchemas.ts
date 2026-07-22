import { z } from "zod/v4";

export const MAX_TEXT_LENGTH = 100_000;
export const MAX_READ_LENGTH = 50_000;
export const MAX_SHEET_CELLS = 10_000;
export const MAX_SHEET_TEXT_LENGTH = 1_000_000;
export const MAX_SLIDES = 50;

const itemIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u, "must be a Google Drive item identifier");
const itemNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f/]+$/u, "must be a bounded Drive item name");
const parentSchema = itemIdSchema.optional().describe("Authorized destination folder ID; defaults to the managed Enterpret root.");
const contentSchema = z.string().max(MAX_TEXT_LENGTH).regex(/^[^\u0000]*$/u, "must not contain NUL");
const readWindowSchema = {
  offset: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional().default(0),
  limit: z.number().int().min(1).max(MAX_READ_LENGTH).optional().default(MAX_READ_LENGTH),
};

function validateReadWindow(
  input: { offset: number; limit: number },
  context: z.RefinementCtx,
): void {
  if (input.offset + input.limit > MAX_TEXT_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `offset plus limit must not exceed ${MAX_TEXT_LENGTH}`,
    });
  }
}

export const emptySchema = z.object({}).strict();
export const createFolderSchema = z.object({ name: itemNameSchema, parent_id: parentSchema }).strict();
export const createTextFileSchema = z
  .object({
    name: itemNameSchema,
    content: contentSchema,
    mime_type: z.enum(["text/plain", "text/markdown", "text/csv"]),
    parent_id: parentSchema,
  })
  .strict();
export const createGoogleDocSchema = z
  .object({ name: itemNameSchema, content: contentSchema, parent_id: parentSchema })
  .strict();

export const cellValueSchema = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);
export const sheetValuesSchema = z
  .array(z.array(cellValueSchema).min(1).max(200))
  .max(1_000)
  .superRefine((rows, context) => {
    if (rows.length > 1 && rows.some((row) => row.length !== rows[0]?.length)) {
      context.addIssue({ code: "custom", message: "must be rectangular" });
    }
    const cellCount = rows.reduce((count, row) => count + row.length, 0);
    if (cellCount > MAX_SHEET_CELLS) {
      context.addIssue({ code: "custom", message: `must contain at most ${MAX_SHEET_CELLS} cells` });
    }
    const textLength = rows.reduce<number>(
      (total, row) =>
        total + row.reduce<number>((rowTotal, cell) => rowTotal + (typeof cell === "string" ? cell.length : 0), 0),
      0,
    );
    if (textLength > MAX_SHEET_TEXT_LENGTH) {
      context.addIssue({ code: "custom", message: `must contain at most ${MAX_SHEET_TEXT_LENGTH} text characters` });
    }
  });
const nonEmptySheetValuesSchema = sheetValuesSchema.refine((rows) => rows.length > 0, {
  message: "must contain at least one row",
});
export const createGoogleSheetSchema = z
  .object({
    name: itemNameSchema,
    values: sheetValuesSchema,
    value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional().default("RAW"),
    parent_id: parentSchema,
  })
  .strict();

export const slideSchema = z
  .object({ title: z.string().max(500), body: z.string().max(10_000) })
  .strict();
const slidesSchema = z.array(slideSchema).min(1).max(MAX_SLIDES);
export const createGooglePresentationSchema = z
  .object({ name: itemNameSchema, slides: slidesSchema, parent_id: parentSchema })
  .strict();

const bareEmailSchema = z
  .string()
  .max(254)
  .email()
  .regex(/^[\x21-\x7e]+$/u, "must be a bare ASCII email address");
export const shareItemSchema = z
  .object({
    item_id: itemIdSchema,
    recipient_type: z.enum(["user", "group"]),
    email: bareEmailSchema,
    role: z.enum(["reader", "commenter", "writer"]),
    send_notification: z.boolean().optional().default(true),
  })
  .strict();

const pageSchema = {
  page_size: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(2_048).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
};
export const authorizedItemTypeSchema = z.enum(["file", "folder", "doc", "sheet", "slides", "blob"]);
export const listAuthorizedItemsSchema = z
  .object({ type: authorizedItemTypeSchema.optional(), ...pageSchema })
  .strict();
export const searchAuthorizedItemsSchema = z
  .object({
    query: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u),
    type: authorizedItemTypeSchema.optional(),
    limit: z.number().int().min(1).max(100).optional().default(50),
  })
  .strict();
export const listWorkspaceItemsSchema = z
  .object({ parent_id: itemIdSchema.optional(), ...pageSchema })
  .strict();
export const searchWorkspaceItemsSchema = z
  .object({
    query: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u),
    ...pageSchema,
  })
  .strict();
export const itemMetadataInputSchema = z.object({ item_id: itemIdSchema }).strict();
export const readTextFileSchema = z
  .object({ item_id: itemIdSchema, ...readWindowSchema })
  .strict()
  .superRefine(validateReadWindow);
export const readGoogleDocSchema = z
  .object({ document_id: itemIdSchema, ...readWindowSchema })
  .strict()
  .superRefine(validateReadWindow);

function columnNumber(column: string): number {
  return [...column.toUpperCase()].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0);
}

function explicitA1CellCount(range: string): number | null {
  const separator = range.lastIndexOf('!');
  if (separator >= 0) {
    const sheetName = range.slice(0, separator);
    const validQuotedName = /^'(?:[^']|'')+'$/u.test(sheetName);
    const validBareName = /^[^'!\u0000-\u001f\u007f]+$/u.test(sheetName);
    if (!validQuotedName && !validBareName) return null;
  }
  const gridRange = range.slice(separator + 1);
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/iu.exec(gridRange);
  if (match === null) return null;
  const startColumn = columnNumber(match[1] ?? '');
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3] ?? match[1] ?? '');
  const endRow = Number(match[4] ?? match[2]);
  if (endColumn < startColumn || endRow < startRow) return null;
  return (endColumn - startColumn + 1) * (endRow - startRow + 1);
}
const a1RangeSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, 'must be bounded A1 notation')
  .superRefine((range, context) => {
    const cellCount = explicitA1CellCount(range);
    if (cellCount === null || cellCount > MAX_SHEET_CELLS) {
      context.addIssue({
        code: 'custom',
        message: `must be an explicit cell or rectangle containing at most ${MAX_SHEET_CELLS} cells`,
      });
    }
  })
  .describe('Explicit bounded A1 cell or rectangle; whole rows, whole columns, and named ranges are unavailable.');
export const readGoogleSheetSchema = z
  .object({ spreadsheet_id: itemIdSchema, range: a1RangeSchema })
  .strict();
export const readGooglePresentationSchema = z
  .object({ presentation_id: itemIdSchema, slide_index: z.number().int().min(0).max(MAX_SLIDES - 1).optional() })
  .strict();
export const replaceTextFileSchema = z.object({ item_id: itemIdSchema, content: contentSchema }).strict();
export const updateGoogleDocSchema = z.object({ document_id: itemIdSchema, content: contentSchema }).strict();
export const updateGoogleSheetSchema = z
  .object({
    spreadsheet_id: itemIdSchema,
    range: a1RangeSchema,
    values: nonEmptySheetValuesSchema,
    value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional().default("RAW"),
  })
  .strict();
export const updateGooglePresentationSchema = z
  .object({ presentation_id: itemIdSchema, slides: slidesSchema })
  .strict();
export const renameItemSchema = z.object({ item_id: itemIdSchema, new_name: itemNameSchema }).strict();
export const moveItemSchema = z.object({ item_id: itemIdSchema, destination_folder_id: itemIdSchema }).strict();
export const copyItemSchema = z
  .object({ item_id: itemIdSchema, destination_folder_id: itemIdSchema.optional(), new_name: itemNameSchema.optional() })
  .strict();
export const trashItemSchema = itemMetadataInputSchema;
export const restoreItemSchema = itemMetadataInputSchema;
export const listItemPermissionsSchema = z.object({ item_id: itemIdSchema, ...pageSchema }).strict();
export const removeItemPermissionSchema = z
  .object({ item_id: itemIdSchema, permission_id: itemIdSchema })
  .strict();

export const itemRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mime_type: z.string(),
    parent_ids: z.array(z.string()),
    web_view_link: z.string().nullable(),
    created_time: z.string().nullable(),
    modified_time: z.string().nullable(),
    trashed: z.boolean(),
  })
  .strict();
export const workspaceResultSchema = z
  .object({ status: z.enum(["found", "created", "restored"]), workspace: itemRefSchema })
  .strict();
function itemResultSchema(status: "created" | "ok" | "updated" | "renamed" | "moved" | "copied" | "trashed" | "restored") {
  return z.object({ status: z.literal(status), item: itemRefSchema }).strict();
}
export const createdItemResultSchema = itemResultSchema("created");
export const metadataItemResultSchema = itemResultSchema("ok");
export const updatedItemResultSchema = itemResultSchema("updated");
export const renamedItemResultSchema = itemResultSchema("renamed");
export const movedItemResultSchema = itemResultSchema("moved");
export const copiedItemResultSchema = itemResultSchema("copied");
export const trashedItemResultSchema = itemResultSchema("trashed");
export const restoredItemResultSchema = itemResultSchema("restored");
export const itemListResultSchema = z
  .object({ status: z.literal("ok"), items: z.array(itemRefSchema), next_cursor: z.string().nullable() })
  .strict();
export const textReadResultSchema = z
  .object({ status: z.literal("ok"), item: itemRefSchema, text: z.string(), next_offset: z.number().nullable() })
  .strict();
export const sheetReadResultSchema = z
  .object({ status: z.literal("ok"), item: itemRefSchema, range: z.string(), values: z.array(z.array(cellValueSchema)) })
  .strict();
export const presentationReadResultSchema = z
  .object({
    status: z.literal("ok"),
    item: itemRefSchema,
    slides: z.array(z.object({ index: z.number(), texts: z.array(z.string()) }).strict()),
    truncated: z.boolean(),
  })
  .strict();
export const permissionSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    role: z.string(),
    email: z.string().nullable(),
    domain: z.string().nullable(),
  })
  .strict();
export const permissionResultSchema = z
  .object({ status: z.literal("shared"), permission: permissionSchema })
  .strict();
export const permissionListResultSchema = z
  .object({ status: z.literal("ok"), permissions: z.array(permissionSchema), next_cursor: z.string().nullable() })
  .strict();
export const removedPermissionResultSchema = z
  .object({ status: z.literal("permission_removed"), item_id: z.string(), permission_id: z.string() })
  .strict();

export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type CreateTextFileInput = z.infer<typeof createTextFileSchema>;
export type CreateGoogleDocInput = z.infer<typeof createGoogleDocSchema>;
export type CreateGoogleSheetInput = z.infer<typeof createGoogleSheetSchema>;
export type CreateGooglePresentationInput = z.infer<typeof createGooglePresentationSchema>;
export type ShareItemInput = z.infer<typeof shareItemSchema>;
export type AuthorizedItemType = z.infer<typeof authorizedItemTypeSchema>;
export type ListAuthorizedItemsInput = z.infer<typeof listAuthorizedItemsSchema>;
export type SearchAuthorizedItemsInput = z.infer<typeof searchAuthorizedItemsSchema>;
export type ListWorkspaceItemsInput = z.infer<typeof listWorkspaceItemsSchema>;
export type SearchWorkspaceItemsInput = z.infer<typeof searchWorkspaceItemsSchema>;
export type ReadTextFileInput = z.infer<typeof readTextFileSchema>;
export type ReadGoogleDocInput = z.infer<typeof readGoogleDocSchema>;
export type ReadGoogleSheetInput = z.infer<typeof readGoogleSheetSchema>;
export type ReadGooglePresentationInput = z.infer<typeof readGooglePresentationSchema>;
export type ReplaceTextFileInput = z.infer<typeof replaceTextFileSchema>;
export type UpdateGoogleDocInput = z.infer<typeof updateGoogleDocSchema>;
export type UpdateGoogleSheetInput = z.infer<typeof updateGoogleSheetSchema>;
export type UpdateGooglePresentationInput = z.infer<typeof updateGooglePresentationSchema>;
export type RenameItemInput = z.infer<typeof renameItemSchema>;
export type MoveItemInput = z.infer<typeof moveItemSchema>;
export type CopyItemInput = z.infer<typeof copyItemSchema>;
export type RemoveItemPermissionInput = z.infer<typeof removeItemPermissionSchema>;
export type ListItemPermissionsInput = z.infer<typeof listItemPermissionsSchema>;
export type CellValue = z.infer<typeof cellValueSchema>;
export type SlideInput = z.infer<typeof slideSchema>;
