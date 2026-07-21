# Google Drive MCP agent guidelines

Read this file, the upstream `README.md`, and `ENTERPRET.md` before changing the fork. Do not commit, push, create a remote, publish a package, or update external systems without explicit authorization.

Keep upstream source and tests intact. Extend the existing entrypoint and shared authentication/dispatch seams when Enterpret uses them; put focused managed-workspace behavior under `src/managed*.ts`, `src/tools/managed*.ts`, and `tests/managed`. Modify shared package, build, documentation, and workflow files only when the Enterpret runtime genuinely depends on the change; never remove unused upstream capabilities merely because the launched Enterpret server does not expose them.

## Fixed package boundary

- Keep the launched MCP surface exactly equal to `GOOGLE_DRIVE_TOOL_NAMES` in `src/managedContract.ts`.
- Keep the only OAuth scope equal to `https://www.googleapis.com/auth/drive.file`.
- Keep stdio-only transport and one external bearer from `GOOGLE_DRIVE_OAUTH_BEARER`.
- Do not add browser OAuth, refresh logic, credential persistence, HTTP transport, service accounts, Calendar, multi-account mode, generic REST, raw queries, local paths, base64 or binary transfer, public/domain sharing, ownership transfer, or permanent deletion.
- Do not add Picker or arbitrary pre-existing/Shared Drive access without a new product and security decision.

## Workspace and safety invariants

- Resolve the fixed visible workspace marker on every subprocess; do not persist IDs or a resource catalog.
- Read-only tools never create or restore the workspace.
- Validate every caller-supplied item and parent ID by ancestry. Reject outside-workspace and root mutations before provider writes.
- Keep inputs and responses bounded. Never surface bearer values, Google response bodies, file contents, recipient addresses, or raw provider errors in logs/errors.
- Retry transient reads only. Never automatically retry writes after dispatch could have begun; represent ambiguous outcomes explicitly.
- Treat MCP annotations as metadata, not trusted host approval policy.

## Validation

Update tests and docs with behavior changes. Before handoff run `npm run check`, packed-file inspection, `npm audit --omit=dev`, and `npm run smoke:pack`. Live Google calls and OAuth configuration require separate authorization.
