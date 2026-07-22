import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type GoogleDriveErrorCode =
  | "DRIVE_ITEM_NOT_AUTHORIZED"
  | "DRIVE_CAPABILITY_DENIED"
  | "DRIVE_ITEM_TYPE_UNSUPPORTED"
  | "DRIVE_PARENT_NOT_AUTHORIZED"
  | "DRIVE_ITEM_NOT_FOUND"
  | "INVALID_INPUT"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "WORKSPACE_NOT_INITIALIZED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_INVALID_RESPONSE"
  | "WRITE_UNKNOWN_OUTCOME"
  | "INTERNAL_ERROR";

export type ErrorOutcome = "not_completed" | "unknown";

export class GoogleDriveMcpError extends Error {
  readonly code: GoogleDriveErrorCode;
  readonly outcome: ErrorOutcome;
  readonly providerStatus?: number;

  constructor(code: GoogleDriveErrorCode, options?: { outcome?: ErrorOutcome; providerStatus?: number }) {
    super(code);
    this.name = "GoogleDriveMcpError";
    this.code = code;
    this.outcome = options?.outcome ?? "not_completed";
    this.providerStatus = options?.providerStatus;
  }
}

const SAFE_MESSAGES: Record<GoogleDriveErrorCode, string> = {
  DRIVE_ITEM_NOT_AUTHORIZED: "The requested Google Drive item is not authorized for this connection.",
  DRIVE_CAPABILITY_DENIED: "Google Drive does not grant the capability required for this operation.",
  DRIVE_ITEM_TYPE_UNSUPPORTED: "This Google Drive item type is not supported for the requested operation.",
  DRIVE_PARENT_NOT_AUTHORIZED: "The requested parent folder is not authorized for this connection.",
  DRIVE_ITEM_NOT_FOUND: "The authorized Google Drive item or subresource no longer exists.",
  INVALID_INPUT: "The request is invalid for this Google Drive tool.",
  AUTHENTICATION_FAILED: "The Google Drive connection could not be authenticated.",
  PERMISSION_DENIED: "The Google Drive connection is not permitted to perform this operation.",
  WORKSPACE_NOT_INITIALIZED: "The managed Enterpret workspace does not exist yet. Create content or call ensure_workspace first.",
  CONFLICT: "The Google Drive operation conflicts with current provider state.",
  RATE_LIMITED: "Google Drive rate-limited the operation.",
  PROVIDER_REJECTED: "Google rejected the operation.",
  PROVIDER_UNAVAILABLE: "Google did not complete the operation.",
  PROVIDER_INVALID_RESPONSE: "Google returned an invalid response.",
  WRITE_UNKNOWN_OUTCOME: "The Google Drive write outcome is unknown. Do not retry automatically.",
  INTERNAL_ERROR: "The Google Drive tool failed safely before a result could be returned.",
};

export function toToolError(error: unknown): CallToolResult {
  const safeError = error instanceof GoogleDriveMcpError ? error : new GoogleDriveMcpError("INTERNAL_ERROR");
  const payload = {
    status: "error",
    error: {
      code: safeError.code,
      message: SAFE_MESSAGES[safeError.code],
      outcome: safeError.outcome,
      retryable: safeError.code === "RATE_LIMITED" || safeError.code === "PROVIDER_UNAVAILABLE",
      ...(safeError.providerStatus === undefined ? {} : { provider_status: safeError.providerStatus }),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
    structuredContent: payload,
  };
}
