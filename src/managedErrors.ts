import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type GoogleDriveErrorCode =
  | "invalid_input"
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "outside_workspace"
  | "workspace_not_initialized"
  | "conflict"
  | "rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "provider_invalid_response"
  | "write_unknown_outcome"
  | "internal_error";

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
  invalid_input: "The request is invalid for this Google Drive tool.",
  authentication_failed: "The Google Drive connection could not be authenticated.",
  permission_denied: "The Google Drive connection is not permitted to perform this operation.",
  not_found: "The requested Google Drive item was not found.",
  outside_workspace: "The requested item is outside the managed Enterpret workspace.",
  workspace_not_initialized: "The managed Enterpret workspace does not exist yet. Create content or call ensure_workspace first.",
  conflict: "The Google Drive operation conflicts with current provider state.",
  rate_limited: "Google Drive rate-limited the operation.",
  provider_rejected: "Google rejected the operation.",
  provider_unavailable: "Google did not complete the operation.",
  provider_invalid_response: "Google returned an invalid response.",
  write_unknown_outcome: "The Google Drive write outcome is unknown. Do not retry automatically.",
  internal_error: "The Google Drive tool failed safely before a result could be returned.",
};

export function toToolError(error: unknown): CallToolResult {
  const safeError = error instanceof GoogleDriveMcpError ? error : new GoogleDriveMcpError("internal_error");
  const payload = {
    status: "error",
    error: {
      code: safeError.code,
      message: SAFE_MESSAGES[safeError.code],
      outcome: safeError.outcome,
      retryable: safeError.code === "rate_limited" || safeError.code === "provider_unavailable",
      ...(safeError.providerStatus === undefined ? {} : { provider_status: safeError.providerStatus }),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
    structuredContent: payload,
  };
}
