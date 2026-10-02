# BrainStrike Monorepo

![BrainStrike Logo](icon.png)

Future‑ready, AI‑assisted productivity apps built with React 19, Vite, Turborepo, and a typed TypeScript stack. This repo contains the Web app, Desktop app, and shared packages powering them.

**CI is disabled due to cost; validation must run locally.** Run `pnpm check`
and include actual local commands, results, and limitations in every PR.
Do not enable or dispatch workflows without the owner's explicit authorization.
[![Node 26.8.2](https://img.shields.io/badge/node-26.8.2-3C873A?logo=node.js&logoColor=white)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-11.15.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

---

## Quick Start

- Prereqs: Node 26.8.2 and the repository-pinned pnpm 11.15.0 (`corepack enable`
  recommended; `package.json#packageManager` is authoritative).
- Install deps: `pnpm install` (pnpm also installs the exact Node 26 runtime
  declared in `devEngines.runtime` for workspace scripts).
- Web dev server: `pnpm dev --filter @brainstrike/web`
- Desktop dev: `pnpm dev --filter @brainstrike/desktop`
- Build all workspaces: `pnpm build`

Tip: Use `--filter <workspace>` to scope any script to a single app/package.

To use a locally hosted chat model, see [Ollama and LM Studio setup](docs/local-model-servers.md).

---

## Monorepo Layout

Selected high-level entries are shown for orientation; this is not an exhaustive
workspace inventory. Use `pnpm-workspace.yaml` and package manifests for the
current complete set.

```
apps/
  web/       # Vite + React web app (Playwright E2E)
  desktop/   # Electron desktop app (Playwright E2E)
packages/
  ui/                 # Shared React components (shadcn/ui + Radix)
  hooks/              # Reusable React hooks
  utils/              # Common utilities
  types/              # Shared types
  app-shell/          # App layout and navigation
  app-state/          # Shared application/model-registry state
  settings-ui/        # User preferences and settings surfaces
  db-explorer/        # Database exploration and file import UI
  vector-management/  # Vector/embedding status and queue management
  pipeline/           # Indexing pipeline orchestration (File → Chunk → Embed → Vector)
  file-explorer/      # Core file explorer state/logic
  file-explorer-ui/   # File explorer UI components
  file-explorer-hooks/# File explorer hooks
  file-system/        # FS abstractions/adapters
  storage/            # Storage abstractions/adapters
  config/             # Shared Biome, TSConfig, and Tailwind v4 configuration
  db/                 # Local DB helpers
  agent/              # Mastra AI agent integration
  embeddings/         # Vector embedding generation
  embedding-worker/   # Worker runtime (renderer)
  queue/              # Job queue infrastructure
  assistant-contract/        # Assistant provider/runtime contracts
  indexing-contract/         # Indexing pipeline contracts
  text-splitter/             # Text chunking utilities
  worker-runtime/            # Shared worker runtime helpers
  build-utils/, chunking-worker/, file-tree-worker/, platform-utils/,
  token-cache/, workers/, file-import/
```

---

## Queue & Embedding Platform (2025-2026)

- **Renderer auto-start**: Desktop auto-starts the embedding worker once the local database is ready and stops it when the renderer unmounts. The web app starts the worker on demand (Start/Reset in Vector Status, or auto-starts when backfill is invoked).
- **Manual controls**:
  - Desktop: no Start/Stop UI toggle; closing the renderer stops the worker.
  - Web: Vector Status exposes Start/Stop/Reset to control the worker in a tab; backfill can auto-start if the worker is stopped.
- **CLI**: `pnpm queue stats` (view queue status), `pnpm queue requeue -- --queue embeddings --limit 20` (retry failed jobs), `pnpm queue prune -- --olderThan <ISO> --states succeeded failed` (clean old records).
- **Configuration**:
  - `VITE_EMBED_CONCURRENCY`: Number of parallel embedding jobs (default 1)
  - `VITE_EMBED_LEASE_MS`: Job lock duration in milliseconds
  - `VITE_EMBED_MODEL_KEY`: Which embedding model to use (provider::modelId format supported)
  - `VITE_QUEUE_TELEMETRY_ENDPOINT` (optional): Enable queue telemetry batching
- **Queue Semantics**: Jobs persist in PGlite/local database via `JobQueue`; the queue respects concurrency limits and automatically retries failed embeddings. Queue adapters expose pause/resume/cancel/drain semantics per ADR-0002. Progress is dispatched via `brainstrike:queue-progress` events for UI subscribers.
- **Re-embed workflow**: Vector Status can clear embeddings for the active set and requeue jobs (model switching/backfill).
- **Persistence**: Queue state and job history are stored in the local database (`@brainstrike/db`); survives app restarts.
- **Pipeline package**: `@brainstrike/pipeline` ships chunking/embedding stages, progress aggregation, controller, and schema health checks. It powers app-shell's background workspace indexing (`workspace-collection-sync-service`) and db-explorer's enhanced file import.
- **Embedding cache**: `@brainstrike/db` provides an embedding cache table and repository (`embedding_cache`, keyed on content hash + model key). The desktop embedding host (#928) and the web in-tab worker (#1640) wire it into `startEmbeddingWorker({ embeddingCache })` by default, so byte-identical content is embedded once and deduped across files and roots.
- **Chunking parsers**: JS/TS chunking uses the native Rust `oxc-parser` in the desktop chunking-host (default-on since #994; kill switch `?parserFlag=babel`) and Babel on web (oxc has no WASM build). Python files chunk via tree-sitter WASM on both apps (default-on since #1011; `?treeSitterLanguages=` overrides, empty value disables).

Web UX notes:
- Vector Status (Right Panel → DB) surfaces Start/Stop/Reset for optional manual control and exposes coverage, throughput, and retry actions.
- Worker badge transitions to `running` automatically when the renderer launches the worker and jobs begin processing.

---

## Common Scripts

- `pnpm dev`: Run all dev servers as defined.
- `pnpm build`: Build every workspace (fails if any one fails).
- `pnpm type-check`: Run TypeScript checks across the repo.
- `pnpm lint`: Biome lint (safe fixes on) and `pnpm format` to write formatting.
- `pnpm test`: Vitest unit/integration tests through Turborepo.
- `pnpm test:e2e`: Playwright E2E (web, functional tests only). Desktop E2E: `pnpm test:e2e:desktop`.
- `pnpm test:e2e:perf`: Run performance E2E tests on demand.
- `pnpm clean`: Clean outputs via Turborepo.

Scope to a package with `--filter`, e.g. `pnpm test --filter @brainstrike/utils`.

### `pnpm check` — local validation

`pnpm check` runs the gates retained in the disabled `.github/workflows/test.yml`,
in the same order and through the same turbo invocations: the Static job's
secret scan, `turbo boundaries`, `pnpm test:scripts`, read-only lint and
type-check; the Build job's build and CSS-bundle validation;
the Unit shards' `turbo run test` and `turbo run test:integration` (unfiltered,
so `packages/db` really runs); the Browser tests lane; and the web + desktop
E2E **smoke** lanes.

- `--fast`: everything above except the runner-heavy lanes (Browser tests, E2E);
  the banner explicitly names those omitted CI gates.
- `--full`: the default plan **plus** the non-required gates —
  `nightly-coverage.yml`'s `coverage:enforce` and the web/desktop full E2E
  regression lanes. Additive, never a swap.
- `--no-install`, `--no-e2e`, `--no-coverage` (only with `--full`, to opt out
  of its coverage gate), `--headless`, `--verbose`.
- `--fix-lint`: run the **writing** lint chain (`lint-all`) instead of CI's
  read-only `lint:ci`. Opt-in on purpose — a gate must not rewrite the tree it
  is judging.

The install is `--frozen-lockfile` (as CI installs), and the Playwright lanes —
and only those — run under `CI=true` so `forbidOnly`, retries, workers and the
CI wait budgets match the required job.

Every run prints the CI gates it does *not* cover — the two native jobs plus
any gates deliberately omitted by its mode flags — with the reason, and
`scripts/__tests__/check-ci-parity.test.mjs` compares the actual commands, not
just step names, so a CI gate can never be neither covered nor explicitly
declared uncovered.

### Performance Test Isolation

Performance tests are separated from functional E2E tests to speed up development:

- **Default behavior**: `pnpm check` and CI run functional tests only (the web
  smoke lane is `--project=functional`; the performance project is never in it)
- **Performance tests**: Run locally via `pnpm test:e2e:perf`, on the daily
  schedule, or manually from GitHub Actions → **Performance E2E** → **Run
  workflow**
- **PR behavior**: PR labels do not trigger this workflow; use manual dispatch
  when a change needs an explicit performance run

---

## Development

- Language: TypeScript (strict). Framework: React 19+ with hooks.
- Styling: Tailwind CSS v4 and `@brainstrike/ui` components.
- State: Zustand where global state is required (see `packages/file-explorer/src/store.ts`).
- Lint/Format: Biome. Run `pnpm lint` and `pnpm format` before committing.
- File naming: kebab-case files/dirs; components export PascalCase; hooks file `use-kebab-case.ts` and export camelCase.
- Commits: Conventional Commits (`feat(ui): add modal`, etc.).
- Never downgrade to “make it work”; fail fast and fix root causes.

More context and expectations for humans and AI agents: `AGENTS.md`.

UI affordances:
- Right Panel → DB tab shows Vector Status (pgvector/worker badges, active Embedding Set selector, coverage, throughput, latency p50/p95, retry‑failed control).

---

## Vector Search Tuning

- **Embedding Sets**: Each embedding set stores documents chunked with a specific model and dimensions. Switch between sets via the UI; incompatible sets (different dimensions) cannot be queried together for safety.
  - Active set is stored per session and persists across reloads
  - Dimension mismatches are caught at query time to prevent silent failures
  - Code search quality: smaller code chunks and model-aware query/doc prompts are enabled
  
- **Model Configuration**: Model selection is per embedding set (created via the Collections dialog). Jobs carry an `embeddingSetId`, and the worker resolves dimensions from the set. `VITE_EMBED_MODEL_KEY` / `EMBED_MODEL_KEY` are fallback defaults for worker initialization or tests. Model selection affects:
  - Output dimensions (typically 384, 768, or 1024)
  - Inference speed (smaller models are faster; larger ones more expressive)
  - On-device vs. API-based inference
  
- **Search Thresholds**: Adjust similarity threshold in UI; default is configurable via env:
  - `VITE_SEARCH_DEFAULT_THRESHOLD` (web)
  - `SEARCH_DEFAULT_THRESHOLD` / `BRAINSTRIKE_SEARCH_DEFAULT_THRESHOLD` (desktop/Node)
  - Value is clamped to [0, 1]; higher = stricter matching
  
- **Index Type**: Set `VECTOR_INDEX_TYPE=ivfflat` to reduce memory (slower but lighter) or rely on default `hnsw` for faster search (higher memory).
  - **IVFFlat**: `IVFFLAT_LISTS=100` controls index granularity; `IVFFLAT_PROBES=8..24` at query time trades recall for speed.
  - **HNSW**: `HNSW_M=16`, `HNSW_EF_CONSTRUCTION=64` tune build memory/quality; `HNSW_EF_SEARCH=32..80` boosts recall at query time.
  - Apply by exporting env vars and restarting the app (auto-migrations will drop/recreate the vector index accordingly).

Notes:
- PGlite + pgvector in WASM benefits from IVFFlat on low-RAM machines; HNSW is best on desktops with more headroom.
- Vector dimensions are stored per embedding set (`embedding_sets.dimensions`) and validated at runtime. Search queries and chunk writes are scoped by the active set to prevent mixing dimensions. The `file_chunks.embedding` column is dimensionless `VECTOR`, with dimension-specific indexes created via expression casts.

---

## Testing

- Unit/Integration (Vitest): `pnpm test` or `pnpm test --filter <pkg>`.
- Focus tests in a package: run inside the package `pnpm vitest run -t "test name"`, or from root `pnpm turbo run test --filter <pkg> -- -- -t "pattern"`.
- E2E (Playwright): `pnpm test:e2e` for Web, `pnpm test:e2e:desktop` for Desktop.
- Type checking: `pnpm type-check` must pass.

CI details and required/advisory lane boundaries live in
[`docs/agents/ci-quality.md`](docs/agents/ci-quality.md). Do not infer the
current workflow from older plans or reports.

---

## Contributing

- Install: `pnpm install` at repo root.
- Add deps to a package: `pnpm add <dep> --filter @brainstrike/<pkg>`.
- Create a new package under `apps/` or `packages/`, set a unique `name` in its `package.json`, ensure it matches workspace globs, then run `pnpm install` to link.
- PRs: include tests, keep TypeScript clean, and ensure `pnpm run check` is green locally.

### Dependency Updates

Shared dependency versions (TypeScript, Vitest, the testing-library family, and other high-fan-out deps) are pinned once in the `catalog:` block in `pnpm-workspace.yaml`; consuming `package.json` files reference them via `"catalog:"` instead of a literal version.

**`react` and `react-dom` are the exception — they are governed by `overrides`, not the catalog.** A bare `overrides` entry shadows a catalog entry completely, and `overrides` is what constrains *transitive* dependencies (the ~157 third-party packages that depend on React), which is what guarantees a single React instance. Bump `overrides` for those two; a catalog entry would govern nothing.

How this is enforced (two layers — read this before assuming `pnpm install` protects you):

- **`pnpm add` / `pnpm update`** — pnpm rejects an off-catalog version itself, via `catalogMode: strict`: `ERR_PNPM_CATALOG_VERSION_MISMATCH`, exit 1.
- **Hand edits** — **plain `pnpm install` does NOT reject drift.** If you hand-edit a catalogued dep to a literal version, `pnpm install` exits 0 and quietly resolves a *second, parallel* copy of that package; `--frozen-lockfile` then passes too. That path is caught in CI by `scripts/verify-catalog-references.mjs` (runs in `pnpm test:scripts`), which fails if any catalogued dep is referenced by a literal version, or if a catalog entry is shadowed by a bare override. To check locally, run `node scripts/verify-catalog-references.mjs` — it reports the same verdict CI does (before BST-836 that command exited 0 unconditionally, so an older green from it proves nothing).

So: a green local `pnpm install` is *not* evidence your version change is legal. Run `pnpm test:scripts` for that.

Check for outdated packages across all workspaces:

```bash
pnpm outdated -r
```

Update a catalogued dependency: bump its version in the `catalog:` block in `pnpm-workspace.yaml` (not in the consuming `package.json`), then run `pnpm install`.

Update a specific non-catalogued dependency in a package:

```bash
pnpm update <dep> --filter @brainstrike/<pkg>
```

`peerDependencies` deliberately keep literal, broad ranges (a compatibility floor is a contract, not a version selection) and are exempt from the catalog.

Coding-agent policy and subsystem routing: [`AGENTS.md`](AGENTS.md). Current
architecture contracts: [`docs/agents/`](docs/agents/). Historical documents
are classified in [`docs/archive/README.md`](docs/archive/README.md).

---

## Troubleshooting

- Node version errors: ensure you’re on Node 26.8.2 (`nvm use` reads `.nvmrc`).
- Playwright prompts: run `pnpm exec playwright install --with-deps chromium` if needed locally.
- Tailwind CSS checks failing in CI: ensure only one `@import "tailwindcss"` per package stylesheet and that the web app scans sources from shared packages; use `TAILWIND_DEBUG=1 pnpm build` to inspect.
- Turborepo caching oddities: `pnpm clean` then retry the command.
- **Module resolution errors after merging/pulling changes**: If you see errors like `ERR_MODULE_NOT_FOUND: Cannot find module '...'` or `Module '"@brainstrike/..."' has no exported member '...'`, the Turborepo cache likely has stale/corrupted build artifacts. Fix with:
  ```bash
  rm -rf .turbo && pnpm run build
  ```
  This clears the cache and forces fresh builds of all packages. Common symptoms include missing exports from `@brainstrike/ui` or `@brainstrike/agent`, or orphaned module files in `dist/` directories.

---

## License

ISC © BrainStrike contributors. See `LICENSE`.
