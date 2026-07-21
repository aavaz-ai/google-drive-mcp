# Third-party provenance

This repository is forked from [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp), release tag `v2.5.0`, commit `f8344e237e39be228616bafae0513e6759d46901`, under the MIT license included in `LICENSE`.

The upstream browser OAuth, credential storage, HTTP server, service-account and team modes, multi-account routing, Calendar integration, broad Drive/Docs/Sheets/Slides tools, resource surface, binary transfer code, entrypoint, and tests remain intact in their original paths. The `@enterpret/google-drive-mcp` executable is built from a small sibling managed entrypoint and cannot import the upstream runtime through package exports. Focused managed-workspace implementation, schemas, tests, documentation, and packaging changes were authored for Enterpret. Git history and `README_UPSTREAM.md` preserve the exact fork lineage and upstream documentation.

Runtime npm dependencies and their exact versions are declared in `package.json` and locked in `package-lock.json`. They are consumed as normal package dependencies rather than vendored source.

Before publication, release review must verify the pinned upstream provenance, retained MIT notice, final packed files, dependency licenses, exact OAuth scope, and absence of credentials. Publishing, tagging, or changing GitHub state requires explicit authorization.
