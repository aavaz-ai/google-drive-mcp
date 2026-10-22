import { Worker } from "node:worker_threads";

import { GoogleDriveMcpError, type GoogleDriveErrorCode } from "./managedErrors.js";
import { MAX_TEXT_LENGTH } from "./tools/managedSchemas.js";

export const DOCUMENT_FORMATS = new Map([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/rtf", "rtf"],
  ["text/rtf", "rtf"],
]);
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 30_000;
const EXTRACTION_ERRORS = new Set<GoogleDriveErrorCode>([
  "DOCUMENT_EXTRACTION_FAILED", "DOCUMENT_ENCRYPTED", "DOCUMENT_NO_EXTRACTABLE_TEXT", "DOCUMENT_LIMIT_EXCEEDED",
]);
let activeWorkers = 0;

export async function extractDocumentText(bytes: Uint8Array, mimeType: string): Promise<string> {
  const format = DOCUMENT_FORMATS.get(mimeType);
  if (format === undefined) throw new GoogleDriveMcpError("DRIVE_ITEM_TYPE_UNSUPPORTED");
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new GoogleDriveMcpError("DOCUMENT_LIMIT_EXCEEDED");
  if (activeWorkers >= 2) throw new GoogleDriveMcpError("PROVIDER_UNAVAILABLE");
  activeWorkers += 1;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // This URL works from both src/ in tests and the bundled dist/index.js.
    worker = new Worker(new URL("../dist/managedFileWorker.js", import.meta.url), {
      workerData: { bytes, format },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    // Parser diagnostics must never enter the MCP protocol or disclose document contents.
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new GoogleDriveMcpError("DOCUMENT_EXTRACTION_TIMEOUT")), EXTRACTION_TIMEOUT_MS);
      worker!.once("error", () => reject(new GoogleDriveMcpError("DOCUMENT_EXTRACTION_FAILED")));
      worker!.once("exit", () => reject(new GoogleDriveMcpError("DOCUMENT_EXTRACTION_FAILED")));
      worker!.once("message", (message: unknown) => {
        if (typeof message !== "object" || message === null) {
          reject(new GoogleDriveMcpError("DOCUMENT_EXTRACTION_FAILED"));
          return;
        }
        const result = message as { text?: unknown; error?: GoogleDriveErrorCode };
        if (result.error !== undefined && EXTRACTION_ERRORS.has(result.error)) {
          reject(new GoogleDriveMcpError(result.error));
        } else if (typeof result.text === "string" && result.text.length <= MAX_TEXT_LENGTH && !result.text.includes("\0") && result.text.trim() !== "") {
          resolve(result.text);
        } else {
          reject(new GoogleDriveMcpError("DOCUMENT_EXTRACTION_FAILED"));
        }
      });
    });
  } finally {
    clearTimeout(timer);
    try {
      if (worker !== undefined) await worker.terminate();
    } finally {
      activeWorkers -= 1;
    }
  }
}
