# Changelog

All notable changes to this package will be documented here.

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
