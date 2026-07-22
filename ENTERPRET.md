# Google Drive no-Picker MCP

Enterpret's small, self-hosted Google Drive MCP for creating and managing app-authorized content inside one marked `Enterpret` folder. It is stdio-only, accepts a host-supplied bearer, and uses only `https://www.googleapis.com/auth/drive.file`.

This fork contains the `@enterpret/google-drive-mcp@0.2.0` release candidate. The package builds one small `src/managedIndex.ts` sibling entrypoint over the focused managed-workspace modules. The original upstream entrypoint, authentication, tools, and tests remain intact in their original paths for future merges and regression coverage, but they are not reachable through the Enterpret package executable. The candidate is ready for local packing and host integration testing, but it has not been published or enabled in production.

## Product boundary

The package does not use Google Picker and cannot browse arbitrary pre-existing Drive or Shared Drive content. It manages content that this OAuth app creates or that Google has otherwise authorized for the app. The package finds or creates one folder named `Enterpret` with a fixed visible description marker; it stores no folder ID or other state.

On every fresh MCP subprocess, the package searches app-authorized Drive files for the marker. If duplicates exist, it chooses the active folder with the earliest creation time and then the lexicographically smallest ID. `ensure_workspace` and creation tools may create or restore the workspace. Read-only tools never do so and return `workspace_not_initialized` when it is absent.

Because the workspace identity is tied to the Google account and OAuth app—not an Enterpret provider connection—the same Google account connected to multiple Enterpret organizations sees the same workspace. Per-connection isolation requires a future platform identity hook.

## Tool surface

The MCP registers exactly these tools:

- Creation: `ensure_workspace`, `create_folder`, `create_text_file`, `create_google_doc`, `create_google_sheet`, `create_google_presentation`
- Discovery: `list_workspace_items`, `search_workspace_items`, `get_item_metadata`
- Reading: `read_text_file`, `read_google_doc`, `read_google_sheet`, `read_google_presentation`
- Updating: `replace_text_file`, `update_google_doc`, `update_google_sheet`, `update_google_presentation`
- Organization: `rename_item`, `move_item`, `copy_item`, `trash_item`, `restore_item`
- Permissions: `share_item`, `list_item_permissions`, `remove_item_permission`

Creation tools automatically ensure the workspace. All supplied item and folder IDs must pass an ancestry check against the active marked workspace. The root cannot be renamed, moved, or trashed. Folder copies are excluded. Trash is reversible; permanent deletion is not exposed.

Text tools accept only bounded UTF-8 `text/plain`, `text/markdown`, or `text/csv` content. Docs use bounded plain text and support single-tab documents only; reads and updates reject multi-tab documents rather than silently operating on one tab. Sheets use bounded two-dimensional values and explicit finite A1 cell or rectangular ranges of at most 10,000 cells; whole-row, whole-column, and named ranges are unavailable. Slides use bounded title/body arrays. Sharing accepts only `user` or `group` recipients and only `reader`, `commenter`, or `writer` roles.

The public surface deliberately excludes raw Drive queries, arbitrary Google API payloads, local paths, base64 upload, binary upload/download, public or domain sharing, ownership transfer, comments, revisions, app properties, rich formatting, charts, Calendar, browser OAuth, service accounts, HTTP transport, token refresh, token files, and multi-account mode.

## Authentication and runtime

Node 22 or later is required. The integrating host starts a fresh MCP child with a refreshed access token in:

```text
GOOGLE_DRIVE_OAUTH_BEARER
```

Missing or blank values fail before startup. The package never accepts a refresh token, opens a browser, persists credentials, writes token files, or exposes provider response bodies. Stdout is reserved for MCP JSON-RPC; stderr diagnostics are fixed and sanitized.

MCP initialization and `tools/list` deliberately remain provider-free. They prove the executable and bearer shape are valid, but they cannot detect an expired token, a scope mismatch, or a disabled Google API. Production connection validation must also call the bounded read-only `list_workspace_items` tool with the real bearer; either a successful result or `workspace_not_initialized` proves the Drive API was reached. This lazy validation matches the Jira MCP pattern, while the Calendar MCP performs a provider probe before advertising tools.

Enable the Google Drive, Docs, Sheets, and Slides APIs in the OAuth application's Google Cloud project. Request exactly:

```text
https://www.googleapis.com/auth/drive.file
```

Google classifies `drive.file` as non-sensitive. Normal OAuth app configuration and verification may still apply. Broadening the scope requires a new security and product review.

## Retry and error behavior

Bounded provider reads retry transient HTTP 429/5xx and transport failures. Writes are never automatically retried. A transport failure or HTTP 5xx after a write dispatch begins returns `write_unknown_outcome`; the caller must not replay the write automatically. Errors expose only stable categories, outcome, and safe HTTP status—not bearer values, input content, recipients, or Google response bodies.

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

Credential-free tests cover exact tool discovery and annotations, managed CLI behavior, strict schemas and excluded surfaces, bearer failure, workspace recreation across fresh clients, deterministic duplicate selection, bounded pagination, ancestry rejection and exhaustion, missing-workspace read behavior, Drive/Docs/Sheets/Slides adapters, single-tab Docs enforcement, bounded response streaming, full-text search ordering, ambiguous-write single dispatch, and MCP initialize/list/call behavior.

The retained upstream regression command runs every original behavior test except three distribution-only suites: `test/integration/cli-args.test.ts`, `test/docs-reference.test.ts`, and `test/schema/registry-metadata.test.ts`. Those sources remain unchanged for future upstream merges, but they assert the upstream browser/HTTP executable, 116-tool README, npm identity, and MCP Registry metadata while this package intentionally builds the managed sibling entrypoint. Focused managed package and CLI tests cover the replacement identity, help, version, bearer, rejected-flag, discovery, packed surface, and stdout-purity contract.

The packed-artifact smoke creates a tarball in a temporary directory and launches that exact artifact through `npx` with a synthetic discovery-only bearer. It makes no Google API call.

Live Google calls, OAuth-provider changes, repository remotes, publication, and production rollout require separate authorization.

## Release hygiene

The Enterpret fork is published from [`aavaz-ai/google-drive-mcp`](https://github.com/aavaz-ai/google-drive-mcp). Keep `piotr-agier/google-drive-mcp` configured as the upstream fetch source, and never publish from or push release commits to that upstream repository.

The GitHub release workflow expects an npm trusted publisher for `@enterpret/google-drive-mcp` and publishes with provenance. Because npm trusted publishing cannot be configured until the package exists, version `0.2.0` needs one authorized bootstrap publication by an `@enterpret` npm owner using interactive authentication and 2FA. Build, inspect, smoke, and publish one exact tarball rather than repacking the source directory:

```bash
npm ci
npm run check
npm audit --audit-level=moderate
npm audit --omit=dev
npm pack --pack-destination /absolute/reviewed-artifact-directory
node scripts/packed-npx-smoke.mjs /absolute/reviewed-artifact-directory/enterpret-google-drive-mcp-0.2.0.tgz
npm publish /absolute/reviewed-artifact-directory/enterpret-google-drive-mcp-0.2.0.tgz --access public
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
