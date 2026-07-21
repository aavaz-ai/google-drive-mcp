# @enterpret/google-drive-mcp

Enterpret's stdio-only Google Drive MCP for app-authorized content inside one marked `Enterpret` folder. This package is a constrained additive build of [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) and uses only the OAuth scope `https://www.googleapis.com/auth/drive.file`.

Source and issue tracking live in [`aavaz-ai/google-drive-mcp`](https://github.com/aavaz-ai/google-drive-mcp). The original upstream documentation is preserved separately so npm users see the narrower Enterpret contract on this page.

## Runtime contract

The host must run Node.js 22 or later and supply one short-lived access token:

```bash
GOOGLE_DRIVE_OAUTH_BEARER='access-token' npx @enterpret/google-drive-mcp
```

The executable accepts only stdio startup, `--help`, and `--version`. It does not provide browser OAuth, token refresh or persistence, HTTP/team/service-account modes, multiple accounts, Calendar, Google Picker, raw Drive queries, binary/local/base64 transfer, public/domain sharing, ownership transfer, or permanent deletion.

The server exposes exactly 25 managed-workspace tools for creation, discovery, bounded reads and updates, organization, reversible trash/restore, and restricted permission management. Every caller-supplied item or parent ID is checked against the active marked workspace before use. Google Docs reads and whole-content replacements support single-tab documents only; multi-tab documents are rejected in V0. Google Sheets reads and updates require an explicit bounded A1 cell or rectangular range.

Writes are dispatched once. If a dispatched write cannot be proven complete, the tool returns `write_unknown_outcome`; callers must not replay it automatically. Provider bodies, bearer values, file contents, and recipients are not included in errors or logs.

See [ENTERPRET.md](ENTERPRET.md) for the complete managed contract and [README_UPSTREAM.md](README_UPSTREAM.md) for the preserved upstream documentation. Third-party provenance is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
