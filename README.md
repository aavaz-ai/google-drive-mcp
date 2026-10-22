# @enterpret/google-drive-mcp

Enterpret's stdio-only Google Drive MCP for app-authorized content in one marked `Enterpret` folder and resources directly authorized through the host's Google Picker flow. V1 covers My Drive and items shared directly with the connected user when Google exposes them to the active `drive.file` bearer after Picker selection or app creation. Shared Drive product support is outside the validated and supported V1 scope. This package is a constrained additive build of [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) and uses only the OAuth scope `https://www.googleapis.com/auth/drive.file`.

Source and issue tracking live in [`aavaz-ai/google-drive-mcp`](https://github.com/aavaz-ai/google-drive-mcp). The original upstream documentation is preserved separately so npm users see the narrower Enterpret contract on this page.

## Runtime contract

The host must run Node.js 22.13.0 or later and supply one short-lived access token:

```bash
GOOGLE_DRIVE_OAUTH_BEARER='access-token' npx @enterpret/google-drive-mcp
```

The executable accepts only stdio startup, `--help`, and `--version`. It does not implement the Picker UI itself, browser OAuth, token refresh or persistence, HTTP/team/service-account modes, multiple accounts, Calendar, raw Drive queries, binary/local/base64 transfer, public/domain sharing, ownership transfer, or permanent deletion.

The server exposes exactly 27 tools for creation, authorized and workspace-only discovery, bounded reads and updates, organization, reversible trash/restore, and restricted permission management. Every caller-supplied item or parent ID is re-fetched through `files.get`; successful resources are classified in memory as workspace descendants or directly authorized resources. External folders are metadata and destination-only. Google Docs reads include all tabs and nested tabs in document order, with labels for multi-tab documents and bounded pagination using `next_offset`. Whole-content replacements remain single-tab only; multi-tab updates are rejected. Google Sheets reads and updates require an explicit bounded A1 cell or rectangular range. Sheet reads preserve Google's sparse row arrays without padding, so trailing empty rows and cells may be omitted and returned row lengths may differ; create and update values remain rectangular.

Writes are dispatched once. If a dispatched write cannot be proven complete, the tool returns `WRITE_UNKNOWN_OUTCOME`; callers must not replay it automatically. Provider bodies, bearer values, file contents, and recipients are not included in errors or logs.

## Reading file contents

| File format | Reader | Output |
| --- | --- | --- |
| Native Google Docs | `read_google_doc` | Text across tabs and nested tabs |
| Native Google Sheets | `read_google_sheet` | Values in an explicit bounded range |
| Native Google Slides | `read_google_presentation` | Slide text |
| TXT, Markdown, CSV | `read_text_file` | UTF-8 text |
| PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF | `read_text_file` | Extracted text, not a layout-preserving rendering |

File selection and `canDownload` permission are required before reading. Listing a file does not prove its contents are readable. Binary documents have a 10 MiB download limit, a 100,000-character extracted-text limit, and bounded complexity and parsing time. Use `next_offset` to page through the extracted text; each page rechecks authorization. Larger documents fail explicitly rather than silently returning only their beginning.

Scanned/image-only PDFs, image interpretation, audio/video, archives, legacy `.doc`/`.xls`/`.ppt`, and password-protected documents are not supported. Images, charts, formulas' calculation logic, and visual layout are not reproduced by text extraction. No OCR, remote conversion service, broader OAuth scope, or file conversion write is performed. Native Sheets/Slides behavior is unchanged by binary-document support.

See [ENTERPRET.md](ENTERPRET.md) for the complete managed contract and [README_UPSTREAM.md](README_UPSTREAM.md) for the preserved upstream documentation. Third-party provenance is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
