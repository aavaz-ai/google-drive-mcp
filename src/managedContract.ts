import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const GOOGLE_DRIVE_OAUTH_BEARER_ENV = "GOOGLE_DRIVE_OAUTH_BEARER" as const;
export const GOOGLE_DRIVE_MCP_PACKAGE_NAME = "@enterpret/google-drive-mcp" as const;
export const GOOGLE_DRIVE_MCP_VERSION = "0.2.0" as const;
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;

export const GOOGLE_DRIVE_TOOL_NAMES = [
  "ensure_workspace",
  "create_folder",
  "create_text_file",
  "create_google_doc",
  "create_google_sheet",
  "create_google_presentation",
  "share_item",
  "list_workspace_items",
  "search_workspace_items",
  "get_item_metadata",
  "read_text_file",
  "read_google_doc",
  "read_google_sheet",
  "read_google_presentation",
  "replace_text_file",
  "update_google_doc",
  "update_google_sheet",
  "update_google_presentation",
  "rename_item",
  "move_item",
  "copy_item",
  "trash_item",
  "restore_item",
  "list_item_permissions",
  "remove_item_permission",
] as const;

export type GoogleDriveToolName = (typeof GOOGLE_DRIVE_TOOL_NAMES)[number];

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const additiveWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const destructiveWrite = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const GOOGLE_DRIVE_TOOL_ANNOTATIONS = {
  ensure_workspace: additiveWrite,
  create_folder: additiveWrite,
  create_text_file: additiveWrite,
  create_google_doc: additiveWrite,
  create_google_sheet: additiveWrite,
  create_google_presentation: additiveWrite,
  share_item: additiveWrite,
  list_workspace_items: readOnly,
  search_workspace_items: readOnly,
  get_item_metadata: readOnly,
  read_text_file: readOnly,
  read_google_doc: readOnly,
  read_google_sheet: readOnly,
  read_google_presentation: readOnly,
  replace_text_file: destructiveWrite,
  update_google_doc: destructiveWrite,
  update_google_sheet: destructiveWrite,
  update_google_presentation: destructiveWrite,
  rename_item: destructiveWrite,
  move_item: destructiveWrite,
  copy_item: additiveWrite,
  trash_item: destructiveWrite,
  restore_item: additiveWrite,
  list_item_permissions: readOnly,
  remove_item_permission: destructiveWrite,
} as const satisfies Record<GoogleDriveToolName, ToolAnnotations>;

export const GOOGLE_DRIVE_TOOL_DESCRIPTIONS = {
  ensure_workspace: "Find, restore, or create the connected Google account's app-managed Enterpret folder.",
  create_folder: "Create a folder inside the managed Enterpret workspace.",
  create_text_file: "Create one bounded UTF-8 plain-text, Markdown, or CSV file inside the managed workspace.",
  create_google_doc: "Create a Google Doc with bounded plain-text content inside the managed workspace.",
  create_google_sheet: "Create a Google Sheet with bounded rectangular values inside the managed workspace.",
  create_google_presentation: "Create a Google Slides presentation from bounded title/body slides inside the managed workspace.",
  share_item: "Share a managed item with one user or group as reader, commenter, or writer. Public, domain, and ownership sharing are unavailable.",
  list_workspace_items: "List direct children of a managed workspace folder. This read never creates a missing workspace.",
  search_workspace_items: "Search app-authorized Drive items by name or full text, returning only descendants of the managed workspace. Raw Drive queries are unavailable.",
  get_item_metadata: "Return bounded metadata for one managed workspace item.",
  read_text_file: "Read a bounded page of a managed UTF-8 text, Markdown, or CSV file.",
  read_google_doc: "Read a bounded plain-text page from a managed single-tab Google Doc. Multi-tab Docs are rejected.",
  read_google_sheet: "Read an explicit bounded A1 cell or rectangular range from a managed Google Sheet.",
  read_google_presentation: "Read bounded text content from a managed Google Slides presentation.",
  replace_text_file: "Replace all content of a managed UTF-8 text, Markdown, or CSV file.",
  update_google_doc: "Replace all plain-text content of a managed single-tab Google Doc. Multi-tab Docs are rejected.",
  update_google_sheet: "Replace values in one explicit bounded A1 cell or rectangular range of a managed Google Sheet.",
  update_google_presentation: "Replace all slides in a managed Google presentation with bounded title/body slides.",
  rename_item: "Rename a managed file or folder. The workspace root cannot be renamed.",
  move_item: "Move a managed item to another managed folder. The workspace root cannot be moved.",
  copy_item: "Copy a managed file into a managed folder.",
  trash_item: "Move a managed item to Google Drive trash. The workspace root cannot be trashed and nothing is permanently deleted.",
  restore_item: "Restore a trashed managed item without permanently deleting anything.",
  list_item_permissions: "List bounded sharing permissions for one managed item.",
  remove_item_permission: "Remove a non-owner permission from one managed item.",
} as const satisfies Record<GoogleDriveToolName, string>;
