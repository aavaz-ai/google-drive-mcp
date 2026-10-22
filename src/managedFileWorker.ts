import { parentPort, workerData } from "node:worker_threads";
import { OfficeParser, type OfficeError, type SupportedFileType } from "officeparser";

import { MAX_TEXT_LENGTH } from "./tools/managedSchemas.js";

const BENIGN_WARNINGS = new Set([
  "PERFORMANCE_TIP", "WHITESPACE_NODE_SKIPPED", "PDF_STRUCT_TREE_UNRELIABLE", "PDF_OUTLINE_TRUNCATED",
]);

function errorCode(code: string): string {
  if (["PASSWORD_REQUIRED", "PASSWORD_INCORRECT", "DOCUMENT_DECRYPTION_FAILED"].includes(code)) return "DOCUMENT_ENCRYPTED";
  if (code === "PDF_NO_TEXT_EXTRACTED") return "DOCUMENT_NO_EXTRACTABLE_TEXT";
  if (code.includes("LIMIT_EXCEEDED") || code === "OUTPUT_TOO_LARGE") return "DOCUMENT_LIMIT_EXCEEDED";
  return "DOCUMENT_EXTRACTION_FAILED";
}

async function run(): Promise<void> {
  try {
    const { bytes, format } = workerData as { bytes: Uint8Array; format: SupportedFileType };
    const buffer = Buffer.from(bytes);
    if (format === "rtf" && !buffer.subarray(0, 16).toString("ascii").startsWith("{\\rtf")) {
      parentPort?.postMessage({ error: "DOCUMENT_EXTRACTION_FAILED" });
      return;
    }
    const ast = await OfficeParser.parseOffice(buffer, {
      fileType: format,
      allowRemoteAssets: false,
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
      pdfParserConfig: { separateProcess: false },
      decompressionLimits: {
        maxUncompressedBytes: 32 * 1024 * 1024,
        maxZipEntries: 2048,
        maxXmlElements: 100_000,
        maxTableCells: 10_000,
        maxRepeatedContent: 100_000,
      },
    });
    const output = await ast.to("text");
    const issue = [...ast.warnings, ...output.messages].find((warning) => !BENIGN_WARNINGS.has(warning.code));
    if (issue !== undefined) {
      parentPort?.postMessage({ error: errorCode(issue.code) });
    } else if (output.value.length > MAX_TEXT_LENGTH) {
      parentPort?.postMessage({ error: "DOCUMENT_LIMIT_EXCEEDED" });
    } else if (output.value.trim() === "") {
      parentPort?.postMessage({ error: "DOCUMENT_NO_EXTRACTABLE_TEXT" });
    } else {
      parentPort?.postMessage({ text: output.value });
    }
  } catch (error) {
    parentPort?.postMessage({ error: errorCode((error as OfficeError)?.officeIssue?.code ?? "") });
  } finally {
    parentPort?.close();
  }
}

void run();
