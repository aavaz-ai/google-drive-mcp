# Changelog

All notable changes to this package will be documented here.

## 0.3.4

- Return `read_google_doc` and `read_text_file` results, or `DOCUMENT_EXTRACTION_TIMEOUT`, within 20 seconds so the call finishes inside the host's 30-second subprocess budget; the deadline aborts in-flight Google requests.
- Request only tab titles and text runs from the Docs API for `read_google_doc`, instead of the full styled document JSON, so large multi-tab Docs read faster.

## 0.3.3

- Extract bounded text from authorized PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, and RTF files through the existing `read_text_file` action.
- Contain extraction in disposable workers with download, expansion, text, concurrency, memory, and time bounds; report encrypted, scanned, damaged, and incomplete documents explicitly.
- Keep the existing `drive.file` scope, download restrictions, per-call authorization, and 27-tool surface. Require Node.js 22.13.0 or later.
- Exercise actual PDF/RTF extraction and denial of an unselected file in the packed-artifact smoke test.

## 0.3.2

- Read all authorized Google Docs tabs and nested tabs with labeled, bounded pagination while retaining single-tab-only whole-document updates.
- Upgrade vulnerable runtime and test dependencies, and replace the build-only shell helper with Node filesystem operations.

## 0.3.1

- Preserve bounded sparse Google Sheets read responses without padding while keeping create and update values rectangular.

## 0.3.0

- Add runtime-only authorization for resources exposed directly to the active `drive.file` bearer while retaining the managed workspace authorization class.
- Add bounded `list_authorized_items` and plain-text `search_authorized_items` discovery with server-built Drive queries and forward-compatible Drive API flags; Shared Drive product support remains outside the validated V1 scope.
- Permit directly authorized files in existing read, update, organization, trash/restore, and restricted permission tools when Google grants the required capabilities.
- Permit directly authorized folders only as metadata targets and creation or move destinations with `canAddChildren`; recursive listing and external-folder mutation remain unavailable.
- Add stable authorization, capability, unsupported-type, parent-authorization, and post-authorization not-found errors without exposing provider bodies or credentials.
- Add MCP-boundary authorization proofs and a stateless live smoke that creates, reads, updates, searches around, and trashes one disposable text file inside a selected authorized folder.

## 0.2.0

- Add discovery, bounded reading, single-tab Docs content replacement, organization, trash/restore, and permission management for descendants of the managed workspace.
- Require ancestry validation for every caller-supplied item or parent ID.
- Add provider response, pagination, explicit Sheets range, and continuation bounds.
- Add bounded read retry, acknowledged-write validation, and ambiguous-write no-retry behavior.
- Keep full-text search valid by omitting Drive ordering only for queries containing `fullText`.
- Override the MCP SDK's unused Hono HTTP adapter to a patched 2.x release so the stdio package installs without known advisories.
- Point npm metadata and provenance-enabled release automation at the Enterpret-owned GitHub fork.

## 0.1.0

- Add a separate Enterpret stdio-only, external-bearer package while retaining the upstream runtime intact.
- Add the marked `Enterpret` workspace and bounded folder, text, Docs, Sheets, Slides, and sharing creation tools.
- Limit the Enterpret package to `drive.file` and exclude browser OAuth, token persistence, service accounts, HTTP transport, Calendar, and multi-account mode from its published surface.
