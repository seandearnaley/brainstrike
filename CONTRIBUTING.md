# Contributing to Brainstrike

Use the Node version in [`.nvmrc`](.nvmrc) and the pnpm version in [`package.json`](package.json). From the repository root:

```sh
pnpm install
pnpm build
pnpm dev --filter @brainstrike/desktop
```

- The desktop renderer uses port 38181 by default; override it with `BRAINSTRIKE_DESKTOP_DEV_SERVER_URL`.
- App-specific commands: [desktop guide](apps/desktop/README.md).
- Project rules for people and agents alike: [AGENTS.md](AGENTS.md). Subsystem contracts live in [`docs/agents/`](docs/agents/), decisions in [`docs/adr/`](docs/adr/).

## Checks and contributions

**The merge queue is the gate.** Every queue batch runs every check, including the full desktop regression, on hosted runners.

- Before opening a PR, run the checks for what you changed. Mergify queues a ready PR once Claude Review has run and every review thread is resolved.
- To run the whole gate before queueing, open the PR as a draft with the `full-check` label.
- Documentation-only changes need review and link checks, not app regressions.
- Other hosted workflows, automated reviews and releases need owner authorization. See [AGENTS.md](AGENTS.md).

| Command | Purpose |
| --- | --- |
| `pnpm check` | Secrets scan, lint, type-check, build, tests and desktop smoke |
| `pnpm build` | Build workspaces |
| `pnpm type-check` | Type checking |
| `pnpm test` | Unit and integration tests |
| `pnpm test:affected` | Unit and integration tests for changed packages |
| `pnpm test:e2e:desktop` | Desktop Playwright tests |

- Scope a package command with `pnpm --filter @brainstrike/<package> <script>`.
- Focused E2E runs: [desktop E2E guide](apps/desktop/e2e/README.md).
- Dependency versions live in the catalogs and overrides in `pnpm-workspace.yaml`; local packages use `workspace:*`. Run `pnpm install` after version changes.

## Build and test configuration

- Workspace packages resolve through their `exports` (pnpm links plus Node type stripping) in TypeScript, Vite and Vitest. Vitest configs carry no `@brainstrike/*` aliases; the one left in Vite is the desktop renderer's `@brainstrike/file-tree-worker` entry.
- A package's `vitest.config.mts` is `mergeConfig(sharedConfig, defineConfig({...}))` with `sharedConfig` from `@brainstrike/test-utils/vitest.base`; `integrationLane(config, include)` derives its `test:integration` config.
- `turbo.jsonc`:
  - `topo` is a transit node that no package defines. `test*` and `type-check` depend on it, so a dependency's source edit re-hashes its dependents without a build. An empty `dependsOn` would replay stale passes.
  - Global `inputs` list only files every task reads. Turbo already hashes each package's lockfile closure and each task definition. The shared tsconfig preset is extended by raw relative path, so its glob is the only thing carrying it into hashes.
  - Strict env mode passes only declared variables. Anything that changes a result goes in `env`; `COVERAGE` and `VITEST_MAX_WORKERS` are `passThroughEnv` so PR and push runs share cache entries.
  - A suite that loads a native add-on declares the add-on `build` edge in its package's `turbo.json`, never an inline `pnpm build &&` (two concurrent node-gyp rebuilds race).
