import { z } from 'zod/v4';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  GOOGLE_DRIVE_TOOL_ANNOTATIONS,
  GOOGLE_DRIVE_TOOL_DESCRIPTIONS,
  GOOGLE_DRIVE_TOOL_NAMES,
  type GoogleDriveToolName,
} from '../managedContract.js';
import { GoogleDriveMcpError, toToolError } from '../managedErrors.js';
import { GoogleDriveClient } from '../managedWorkspace.js';
import {
  copyItemSchema,
  copiedItemResultSchema,
  createdItemResultSchema,
  createFolderSchema,
  createGoogleDocSchema,
  createGooglePresentationSchema,
  createGoogleSheetSchema,
  createTextFileSchema,
  emptySchema,
  itemListResultSchema,
  itemMetadataInputSchema,
  listAuthorizedItemsSchema,
  listItemPermissionsSchema,
  listWorkspaceItemsSchema,
  metadataItemResultSchema,
  moveItemSchema,
  movedItemResultSchema,
  permissionListResultSchema,
  permissionResultSchema,
  presentationReadResultSchema,
  readGoogleDocSchema,
  readGooglePresentationSchema,
  readGoogleSheetSchema,
  readTextFileSchema,
  renamedItemResultSchema,
  removeItemPermissionSchema,
  removedPermissionResultSchema,
  renameItemSchema,
  replaceTextFileSchema,
  restoreItemSchema,
  restoredItemResultSchema,
  searchWorkspaceItemsSchema,
  searchAuthorizedItemsSchema,
  shareItemSchema,
  sheetReadResultSchema,
  textReadResultSchema,
  trashItemSchema,
  trashedItemResultSchema,
  updateGoogleDocSchema,
  updateGooglePresentationSchema,
  updateGoogleSheetSchema,
  updatedItemResultSchema,
  workspaceResultSchema,
} from './managedSchemas.js';

type ToolSchema = z.ZodType;

const TOOL_SCHEMAS = {
  ensure_workspace: { input: emptySchema, output: workspaceResultSchema },
  create_folder: { input: createFolderSchema, output: createdItemResultSchema },
  create_text_file: { input: createTextFileSchema, output: createdItemResultSchema },
  create_google_doc: { input: createGoogleDocSchema, output: createdItemResultSchema },
  create_google_sheet: { input: createGoogleSheetSchema, output: createdItemResultSchema },
  create_google_presentation: { input: createGooglePresentationSchema, output: createdItemResultSchema },
  share_item: { input: shareItemSchema, output: permissionResultSchema },
  list_authorized_items: { input: listAuthorizedItemsSchema, output: itemListResultSchema },
  search_authorized_items: { input: searchAuthorizedItemsSchema, output: itemListResultSchema },
  list_workspace_items: { input: listWorkspaceItemsSchema, output: itemListResultSchema },
  search_workspace_items: { input: searchWorkspaceItemsSchema, output: itemListResultSchema },
  get_item_metadata: { input: itemMetadataInputSchema, output: metadataItemResultSchema },
  read_text_file: { input: readTextFileSchema, output: textReadResultSchema },
  read_google_doc: { input: readGoogleDocSchema, output: textReadResultSchema },
  read_google_sheet: { input: readGoogleSheetSchema, output: sheetReadResultSchema },
  read_google_presentation: { input: readGooglePresentationSchema, output: presentationReadResultSchema },
  replace_text_file: { input: replaceTextFileSchema, output: updatedItemResultSchema },
  update_google_doc: { input: updateGoogleDocSchema, output: updatedItemResultSchema },
  update_google_sheet: { input: updateGoogleSheetSchema, output: updatedItemResultSchema },
  update_google_presentation: { input: updateGooglePresentationSchema, output: updatedItemResultSchema },
  rename_item: { input: renameItemSchema, output: renamedItemResultSchema },
  move_item: { input: moveItemSchema, output: movedItemResultSchema },
  copy_item: { input: copyItemSchema, output: copiedItemResultSchema },
  trash_item: { input: trashItemSchema, output: trashedItemResultSchema },
  restore_item: { input: restoreItemSchema, output: restoredItemResultSchema },
  list_item_permissions: { input: listItemPermissionsSchema, output: permissionListResultSchema },
  remove_item_permission: { input: removeItemPermissionSchema, output: removedPermissionResultSchema },
} as const satisfies Record<GoogleDriveToolName, { input: ToolSchema; output: ToolSchema }>;

function toJsonSchema(schema: ToolSchema): Tool['inputSchema'] {
  return z.toJSONSchema(schema) as Tool['inputSchema'];
}

export const toolDefinitions: Tool[] = GOOGLE_DRIVE_TOOL_NAMES.map((name) => ({
  name,
  description: GOOGLE_DRIVE_TOOL_DESCRIPTIONS[name],
  inputSchema: toJsonSchema(TOOL_SCHEMAS[name].input),
  outputSchema: toJsonSchema(TOOL_SCHEMAS[name].output),
  annotations: GOOGLE_DRIVE_TOOL_ANNOTATIONS[name],
}));

function parse<T extends ToolSchema>(schema: T, args: Record<string, unknown>): z.output<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new GoogleDriveMcpError('INVALID_INPUT');
  return parsed.data;
}

function success(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: GoogleDriveClient,
): Promise<CallToolResult | null> {
  if (!GOOGLE_DRIVE_TOOL_NAMES.includes(name as GoogleDriveToolName)) return null;

  try {
    let result: Record<string, unknown>;
    switch (name as GoogleDriveToolName) {
      case 'ensure_workspace':
        parse(emptySchema, args);
        result = await client.ensureWorkspace();
        break;
      case 'create_folder':
        result = await client.createFolder(parse(createFolderSchema, args));
        break;
      case 'create_text_file':
        result = await client.createTextFile(parse(createTextFileSchema, args));
        break;
      case 'create_google_doc':
        result = await client.createGoogleDoc(parse(createGoogleDocSchema, args));
        break;
      case 'create_google_sheet':
        result = await client.createGoogleSheet(parse(createGoogleSheetSchema, args));
        break;
      case 'create_google_presentation':
        result = await client.createGooglePresentation(parse(createGooglePresentationSchema, args));
        break;
      case 'share_item':
        result = await client.shareItem(parse(shareItemSchema, args));
        break;
      case 'list_authorized_items':
        result = await client.listAuthorizedItems(parse(listAuthorizedItemsSchema, args));
        break;
      case 'search_authorized_items':
        result = await client.searchAuthorizedItems(parse(searchAuthorizedItemsSchema, args));
        break;
      case 'list_workspace_items':
        result = await client.listWorkspaceItems(parse(listWorkspaceItemsSchema, args));
        break;
      case 'search_workspace_items':
        result = await client.searchWorkspaceItems(parse(searchWorkspaceItemsSchema, args));
        break;
      case 'get_item_metadata': {
        const input = parse(itemMetadataInputSchema, args);
        result = await client.getItemMetadata(input.item_id);
        break;
      }
      case 'read_text_file':
        result = await client.readTextFile(parse(readTextFileSchema, args));
        break;
      case 'read_google_doc':
        result = await client.readGoogleDoc(parse(readGoogleDocSchema, args));
        break;
      case 'read_google_sheet':
        result = await client.readGoogleSheet(parse(readGoogleSheetSchema, args));
        break;
      case 'read_google_presentation':
        result = await client.readGooglePresentation(parse(readGooglePresentationSchema, args));
        break;
      case 'replace_text_file':
        result = await client.replaceTextFile(parse(replaceTextFileSchema, args));
        break;
      case 'update_google_doc':
        result = await client.updateGoogleDoc(parse(updateGoogleDocSchema, args));
        break;
      case 'update_google_sheet':
        result = await client.updateGoogleSheet(parse(updateGoogleSheetSchema, args));
        break;
      case 'update_google_presentation':
        result = await client.updateGooglePresentation(parse(updateGooglePresentationSchema, args));
        break;
      case 'rename_item':
        result = await client.renameItem(parse(renameItemSchema, args));
        break;
      case 'move_item': {
        const input = parse(moveItemSchema, args);
        result = await client.moveItem(input.item_id, input.destination_folder_id);
        break;
      }
      case 'copy_item':
        result = await client.copyItem(parse(copyItemSchema, args));
        break;
      case 'trash_item': {
        const input = parse(trashItemSchema, args);
        result = await client.trashItem(input.item_id);
        break;
      }
      case 'restore_item': {
        const input = parse(restoreItemSchema, args);
        result = await client.restoreItem(input.item_id);
        break;
      }
      case 'list_item_permissions':
        result = await client.listItemPermissions(parse(listItemPermissionsSchema, args));
        break;
      case 'remove_item_permission':
        result = await client.removeItemPermission(parse(removeItemPermissionSchema, args));
        break;
    }
    return success(result);
  } catch (error) {
    return toToolError(error);
  }
}
