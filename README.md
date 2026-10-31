# Brainstrike

![Brainstrike logo](apps/desktop/build/icons/128x128.png)

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

Desktop's renderer uses port 38181 by default. The dev URL can be configured
through `BRAINSTRIKE_DESKTOP_DEV_SERVER_URL`.

See the [desktop](apps/desktop/README.md) guide for
app-specific commands.

## Architecture

- **Desktop:** the shared agent host owns runs, conversations and the canonical
  catalog through its committed log and SQLite StateStore. The derived SQLite
  index runs in a separate process.
- **Models:** chat and embeddings come from hosted providers; the app runs no
  local models.
- **Shared code:** `packages/` contains UI, contracts, host/storage/indexing owners,
  provider adapters and inference libraries. Use
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml) and package manifests for inventory.

Current boundaries are documented in [subsystem contracts](docs/agents/).
[ADRs](docs/adr/) record architecture decisions.

## Checks and contributions

**The merge queue is the gate.** Every queue batch runs every check, including
the full desktop regression, on hosted runners. Before opening a PR, run the
checks for what you changed: Mergify queues a ready PR by itself. To run the
whole gate on a PR before it queues, open it as a draft with the `full-check`
label. Documentation changes need review and link checks, not app regressions.

Useful root commands:

| Command | Purpose |
| --- | --- |
| `pnpm check` | Secrets scan, lint, type-check, build, tests and desktop smoke |
| `pnpm build` | Build workspaces |
| `pnpm type-check` | Type checking |
| `pnpm test` | Unit and integration tests |
| `pnpm test:e2e:desktop` | Desktop Playwright tests |

Scope package commands with `pnpm --filter @brainstrike/<package> <script>`.
Use the [desktop](apps/desktop/e2e/README.md) E2E guide for focused runs.

Branch from current main, keep the change coherent and report actual validation
and omissions in the PR. Other hosted workflows, automated reviews and releases
need owner authorization. Follow [agent/contribution policy](AGENTS.md).

Dependency versions are owned by workspace catalogs and overrides in
`pnpm-workspace.yaml`; use `workspace:*` for local packages. After version changes,
run `pnpm install`.

## License

ISC. See [LICENSE](LICENSE); package-specific notices remain with each package.
