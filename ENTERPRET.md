# Google Drive app-authorized MCP

Enterpret's small, self-hosted Google Drive MCP for creating and managing app-authorized content inside one marked `Enterpret` folder and content directly authorized through the host's Picker flow. It is stdio-only, accepts a host-supplied bearer, and uses only `https://www.googleapis.com/auth/drive.file`.

This fork contains the `@enterpret/google-drive-mcp@0.3.0` release candidate. The package builds one small `src/managedIndex.ts` sibling entrypoint over the focused managed-workspace modules. The original upstream entrypoint, authentication, tools, and tests remain intact in their original paths for future merges and regression coverage, but they are not reachable through the Enterpret package executable. The candidate is ready for local packing and host integration testing, but it has not been published or enabled in production.

## Product boundary

The package does not implement or call Google Picker. V1 covers My Drive and items shared directly with the connected user when the host uses Picker to authorize them to the same OAuth app, plus items created by the app. The MCP can discover and operate only on resources that Google exposes to its active `drive.file` bearer; it cannot browse arbitrary pre-existing Drive content. Shared Drive product support is outside the validated and supported V1 scope. The package keeps Drive API compatibility flags where accepted, but those parameters are not a Shared Drive feature commitment. The package finds or creates one folder named `Enterpret` with a fixed visible description marker; it stores no folder ID or other resource state.

For each caller-supplied ID, the MCP first calls `files.get` with bounded sanitized metadata, relevant capabilities, and `supportsAllDrives=true`. A successful item is classified for that invocation only as either `workspace` (the marked folder or a proven descendant) or `external_authorized` (directly visible outside that workspace). A Drive 404 fails closed as `DRIVE_ITEM_NOT_AUTHORIZED`; no ID catalog or classification is persisted.

On every fresh MCP subprocess, the package searches app-authorized Drive files for the marker. If duplicates exist, it chooses the active folder with the earliest creation time and then the lexicographically smallest ID. `ensure_workspace` and creation tools may create or restore the workspace. Read-only tools never do so and return `WORKSPACE_NOT_INITIALIZED` when it is absent.

Because the workspace identity is tied to the Google account and OAuth app—not an Enterpret provider connection—the same Google account connected to multiple Enterpret organizations sees the same workspace. Per-connection isolation requires a future platform identity hook.

## Tool surface

The MCP registers exactly these tools:

- Creation: `ensure_workspace`, `create_folder`, `create_text_file`, `create_google_doc`, `create_google_sheet`, `create_google_presentation`
- Discovery: `list_authorized_items`, `search_authorized_items`, `list_workspace_items`, `search_workspace_items`, `get_item_metadata`
- Reading: `read_text_file`, `read_google_doc`, `read_google_sheet`, `read_google_presentation`
- Updating: `replace_text_file`, `update_google_doc`, `update_google_sheet`, `update_google_presentation`
- Organization: `rename_item`, `move_item`, `copy_item`, `trash_item`, `restore_item`
- Permissions: `share_item`, `list_item_permissions`, `remove_item_permission`

Creation tools automatically ensure the workspace only when `parent_id` is omitted. A supplied workspace or directly authorized folder may be a creation or move destination when Google reports `canAddChildren=true`. Directly authorized files may use existing metadata/content reads, content updates, rename, move, copy, trash/restore, and restricted permission tools when the corresponding capability is granted. Directly authorized folders are narrower: metadata and destination use are allowed, but recursive listing, rename, move, trash/restore, sharing, and permission management are not. `list_workspace_items` remains workspace-only. The workspace root cannot be renamed, moved, trashed, or shared. Folder copies are excluded. Trash is reversible; permanent deletion is not exposed.

Text tools accept only bounded UTF-8 `text/plain`, `text/markdown`, or `text/csv` content. Docs use bounded plain text and support single-tab documents only; reads and updates reject multi-tab documents rather than silently operating on one tab. Sheets use bounded two-dimensional values and explicit finite A1 cell or rectangular ranges of at most 10,000 cells; whole-row, whole-column, and named ranges are unavailable. Slides use bounded title/body arrays. Sharing accepts only `user` or `group` recipients and only `reader`, `commenter`, or `writer` roles.

`list_authorized_items` supports bounded paging and the server-defined `file`, `folder`, `doc`, `sheet`, `slides`, and `blob` filters. `search_authorized_items` accepts only bounded plain text, an optional type filter, and a bounded result limit; the server escapes the text and constructs the Drive query. The public surface deliberately excludes raw Drive queries, arbitrary Google API payloads, local paths, base64 upload, binary upload/download/export artifact bridges, public or domain sharing, ownership transfer, comments, revisions, app properties, rich formatting, charts, Calendar, browser OAuth, service accounts, HTTP transport, token refresh, token files, and multi-account mode.

## Authentication and runtime

Node 22 or later is required. The integrating host starts a fresh MCP child with a refreshed access token in:

```text
GOOGLE_DRIVE_OAUTH_BEARER
```

Missing or blank values fail before startup. The package never accepts a refresh token, opens a browser, persists credentials, writes token files, or exposes provider response bodies. Stdout is reserved for MCP JSON-RPC; stderr diagnostics are fixed and sanitized.

MCP initialization and `tools/list` deliberately remain provider-free. They prove the executable and bearer shape are valid, but they cannot detect an expired token, a scope mismatch, or a disabled Google API. Production connection validation must also call the bounded read-only `list_authorized_items` tool with the real bearer. This lazy validation matches the Jira MCP pattern, while the Calendar MCP performs a provider probe before advertising tools.

Enable the Google Drive, Docs, Sheets, and Slides APIs in the OAuth application's Google Cloud project. Request exactly:

```text
https://www.googleapis.com/auth/drive.file
```

Google classifies `drive.file` as non-sensitive. Normal OAuth app configuration and verification may still apply. Broadening the scope requires a new security and product review.

## Retry and error behavior

Bounded provider reads retry transient HTTP 429/5xx and transport failures. Writes are never automatically retried. A transport failure or HTTP 5xx after a write dispatch begins returns `WRITE_UNKNOWN_OUTCOME`; the caller must not replay the write automatically. Authorization and operation failures use `DRIVE_ITEM_NOT_AUTHORIZED`, `DRIVE_CAPABILITY_DENIED`, `DRIVE_ITEM_TYPE_UNSUPPORTED`, `DRIVE_PARENT_NOT_AUTHORIZED`, and `DRIVE_ITEM_NOT_FOUND`. Errors expose only stable categories, outcome, and safe HTTP status—not bearer values, input content, recipients, or Google response bodies.

MCP tool annotations describe the operations, but trusted host policy remains responsible for presenting approvals and preventing unsafe replay.

## Development and validation

```bash
npm ci
npm run check
node dist/index.js --version
npm pack --dry-run
npm audit --audit-level=moderate
npm audit --omit=dev
npm run smoke:pack
```

Credential-free tests cover exact tool discovery and annotations, managed CLI behavior, strict schemas and excluded surfaces, bearer failure, workspace recreation across fresh clients, directly authorized content reads/updates, selected-folder destinations, unpicked IDs, capability denials, bounded authorized discovery and query escaping, Drive API compatibility flags, deterministic duplicate selection, bounded pagination, ancestry exhaustion, missing-workspace read behavior, Drive/Docs/Sheets/Slides adapters, single-tab Docs enforcement, bounded response streaming, full-text search ordering, ambiguous-write single dispatch, and MCP initialize/list/call behavior. Focused MCP-boundary tests exercise positive authorized list/search results, Picker-authorized read/update, selected-folder creation, non-recursive folder authorization, and all five Phase 1 failure codes in both text and structured results. A mocked fresh subprocess proves that authorization is re-evaluated with the bearer supplied to that process.

The retained upstream regression command runs every original behavior test except three distribution-only suites: `test/integration/cli-args.test.ts`, `test/docs-reference.test.ts`, and `test/schema/registry-metadata.test.ts`. Those sources remain unchanged for future upstream merges, but they assert the upstream browser/HTTP executable, 116-tool README, npm identity, and MCP Registry metadata while this package intentionally builds the managed sibling entrypoint. Focused managed package and CLI tests cover the replacement identity, help, version, bearer, rejected-flag, discovery, packed surface, and stdout-purity contract.

The packed-artifact smoke creates a tarball in a temporary directory and launches that exact artifact through `npx` with a synthetic discovery-only bearer. It makes no Google API call.

For an explicitly authorized live acceptance check, first export a freshly refreshed bearer without writing it to disk, then run the following with one My Drive or directly shared Picker-authorized folder ID and one known independently added or unpicked child ID:

```bash
npm run build
GOOGLE_DRIVE_AUTHORIZED_FOLDER_ID='selected-folder-id' \
GOOGLE_DRIVE_UNPICKED_CHILD_ID='unpicked-child-id' \
npm run smoke:live:fresh
```

The command launches a fresh stateless MCP child and proves authorized list/search, selected-folder destination creation, read/update of one uniquely named disposable text file, and `DRIVE_ITEM_NOT_AUTHORIZED` for the unpicked child. Cleanup trashes the disposable file exactly once; it never permanently deletes or automatically retries an ambiguous write. Cleanup failure is explicit. The command does not print or persist the bearer or supplied item IDs.

Live Google calls, OAuth-provider changes, repository remotes, publication, and production rollout require separate authorization.

## Release hygiene

The Enterpret fork is published from [`aavaz-ai/google-drive-mcp`](https://github.com/aavaz-ai/google-drive-mcp). Keep `piotr-agier/google-drive-mcp` configured as the upstream fetch source, and never publish from or push release commits to that upstream repository.

The GitHub release workflow expects an npm trusted publisher for `@enterpret/google-drive-mcp` and publishes with provenance. Publication requires separate authorization. Build, inspect, smoke, and publish one exact tarball rather than repacking the source directory:

```bash
npm ci
npm run check
npm audit --audit-level=moderate
npm audit --omit=dev
npm pack --pack-destination /absolute/reviewed-artifact-directory
node scripts/packed-npx-smoke.mjs /absolute/reviewed-artifact-directory/enterpret-google-drive-mcp-0.3.0.tgz
npm publish /absolute/reviewed-artifact-directory/enterpret-google-drive-mcp-0.3.0.tgz --access public
```

After the bootstrap publication, verify the registry checksum and exact-version `npx` surface. Then create a protected GitHub environment named `npm` with required reviewers and configure npm Trusted Publishing with GitHub organization `aavaz-ai`, repository `google-drive-mcp`, workflow filename `publish.yml`, and environment `npm`. Subsequent GitHub releases must use a `v<package-version>` tag that exactly matches `package.json`; the workflow serializes releases and publishes the same tarball it smokes.

Before any release, run the complete validation commands above, inspect the packed file list, confirm the target commit and tag, and verify that no credentials or local artifacts are present. Publish the package before enabling or deploying a Wisdom manifest that pins it.

## Provenance

This package is an additive Enterpret build in a fork of the MIT-licensed `piotr-agier/google-drive-mcp` repository. The upstream runtime and tests remain in their original paths so future upstream changes can be incorporated cleanly. Enterpret's thin sibling entrypoint, bearer validator, managed-workspace code, schemas, and server seam live under `src/managed*.ts` and `src/tools/managed*.ts`. The launched MCP server exposes only the narrower implementation documented above. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the preserved [README_UPSTREAM.md](README_UPSTREAM.md).

## References

- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Drive files API](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Google Docs API](https://developers.google.com/workspace/docs/api/reference/rest)
- [Google Sheets API](https://developers.google.com/workspace/sheets/api/reference/rest)
- [Google Slides API](https://developers.google.com/workspace/slides/api/reference/rest)
