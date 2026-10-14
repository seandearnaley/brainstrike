# Brainstrike

![Brainstrike logo](apps/web/public/icons/icon-192x192.png)

Brainstrike is a local-first workspace and AI assistant app built with React,
TypeScript, Vite, Electron and pnpm workspaces.

## Start developing

Use the Node version in [`.nvmrc`](.nvmrc) and the pnpm version in
[`package.json`](package.json). From the repository root:

```sh
pnpm install
pnpm build
pnpm dev --filter @brainstrike/desktop
```

For the web app, run `pnpm dev --filter @brainstrike/web`. Desktop's renderer
uses port 38181 by default; web uses 8080. The desktop dev URL can be configured
through `BRAINSTRIKE_DESKTOP_DEV_SERVER_URL`; web Vite accepts `--port`.

See the [desktop](apps/desktop/README.md) and [web](apps/web/README.md) guides for
app-specific commands. [Ollama and LM Studio setup](docs/local-model-servers.md)
covers local model servers.

## Architecture

- **Desktop:** the shared agent host owns runs, conversations and the canonical
  catalog through its committed log and SQLite StateStore. The derived SQLite
  index runs in a separate process. Desktop no longer constructs PGlite or
  exposes the old renderer SQL bridge.
- **Inference:** desktop embeddings and local model generation run in hidden
  renderer hosts. Electron main coordinates their lifecycle and authorized IPC.
- **Web:** browser database and explicit test/conformance consumers still use
  PGlite. Hosted chat uses the server request boundary; desktop-only capabilities
  are omitted where unavailable. Web is not the desktop host runtime.
- **Shared code:** `packages/` contains UI, contracts, host/storage/indexing owners,
  provider adapters and inference libraries. Use
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml) and package manifests for inventory.

Current boundaries are documented in [subsystem contracts](docs/agents/).
[ADRs](docs/adr/) record architecture decisions;
[archived documents](docs/archive/README.md) are historical evidence.

## Checks and contributions

**CI is disabled due to cost; validation must run locally.** Choose checks for
what changed, using [validation guidance](docs/agents/ci-quality.md).
Documentation changes need review and link checks, not app regressions.

Useful root commands:

| Command | Purpose |
| --- | --- |
| `pnpm check:routine` | Routine local validation plan |
| `pnpm check --full` | Complete integration, coverage and E2E plan |
| `pnpm build` | Build workspaces |
| `pnpm type-check` | Type checking |
| `pnpm test` | Unit and integration tests |
| `pnpm --filter @brainstrike/web test:e2e` | Web Playwright tests |
| `pnpm test:e2e:desktop` | Desktop Playwright tests |

Scope package commands with `pnpm --filter @brainstrike/<package> <script>`.
Use the [web](apps/web/e2e/README.md) or
[desktop](apps/desktop/e2e/README.md) E2E guide for focused runs.

Branch from current main, keep the change coherent and report actual validation
and omissions in the PR. Hosted workflows, automated reviews and releases need
owner authorization. Follow [agent/contribution policy](AGENTS.md).

Dependency versions are owned by workspace catalogs and overrides in
`pnpm-workspace.yaml`; use `workspace:*` for local packages. After version changes,
run `pnpm install` and `node scripts/verify-catalog-references.mjs`. Installation
alone does not prove catalog compliance.

## License

ISC. See [LICENSE](LICENSE); package-specific notices remain with each package.
