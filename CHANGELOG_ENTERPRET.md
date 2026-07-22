# Changelog

All notable changes to this package will be documented here.

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
