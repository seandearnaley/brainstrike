# BrainStrike Monorepo

![BrainStrike Logo](icon.png)

Future‑ready, AI‑assisted productivity apps built with React 19, Vite, Turborepo, and a typed TypeScript stack. This repo contains the Web app, Desktop app, and shared packages powering them.

[![CI](https://github.com/seandearnaley/brainstrike/actions/workflows/test.yml/badge.svg)](https://github.com/seandearnaley/brainstrike/actions/workflows/test.yml)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22.x-3C873A?logo=node.js&logoColor=white)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

---

## Quick Start

- Prereqs: Node 22.x+, pnpm 10.x (`corepack enable` recommended).
- Install deps: `pnpm install`
- Web dev server: `pnpm dev --filter @brainstrike/web`
- Desktop dev: `pnpm dev --filter @brainstrike/desktop`
- Build all workspaces: `pnpm build`

Tip: Use `--filter <workspace>` to scope any script to a single app/package.

---

## Monorepo Layout

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
  preferences/        # User preferences and settings stores
  db-explorer/        # Database exploration and file import UI
  vector-management/  # Vector/embedding status and queue management
  pipeline/           # Indexing pipeline orchestration (File → Chunk → Embed → Vector)
  file-explorer/      # Core file explorer state/logic
  file-explorer-ui/   # File explorer UI components
  file-explorer-hooks/# File explorer hooks
  selection-rules/    # File selection rules engine + schema
  file-system/        # FS abstractions/adapters
  storage/            # Storage abstractions/adapters
  server-config/      # Server config utilities
  tailwind-config/    # Shared Tailwind v4 config
  config/             # Biome + TSConfig
  db/                 # Local DB helpers
  agent/              # Mastra AI agent integration
  embeddings/         # Vector embedding generation
  embedding-worker/   # Worker runtime (renderer)
  queue/              # Job queue infrastructure
  queue-telemetry-collector/ # Queue telemetry collector service
  assistant-contract/        # Assistant provider/runtime contracts
  indexing-contract/         # Indexing pipeline contracts
  text-splitter/             # Text chunking utilities
  worker-runtime/            # Shared worker runtime helpers
  build-utils/, chunking-worker/, file-tree-worker/, platform-utils/,
  token-cache/, workers/, file-import/
```

See also: [`apps/docs/docs/getting-started/onboarding.md`](apps/docs/docs/getting-started/onboarding.md) and [`apps/docs/docs/development/monorepo-workflow.md`](apps/docs/docs/development/monorepo-workflow.md) for deep dives into architecture and workflow.

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
- **Pipeline package**: `@brainstrike/pipeline` ships chunking/embedding stages, progress aggregation, controller, and schema health checks. It is currently exercised in tests and not yet wired into the apps.
- **Embedding cache (opt-in)**: `@brainstrike/db` provides an embedding cache table and repository; `startEmbeddingWorker({ embeddingCache })` can use it for content-level dedupe but it is not wired by default.

Refer to [`apps/docs/docs/archive/cold/arch-logs/20250905-000000-db-embedding-modernization/20250905-130000-phase-3-handoff.md`](apps/docs/docs/archive/cold/arch-logs/20250905-000000-db-embedding-modernization/20250905-130000-phase-3-handoff.md) (Post-Review Deltas) and
[`apps/docs/docs/archive/cold/arch-logs/20250905-170000-db-embedding-modernization-2025.md`](apps/docs/docs/archive/cold/arch-logs/20250905-170000-db-embedding-modernization-2025.md) for the phased plan. API shapes:
[`apps/docs/docs/archive/cold/arch-logs/20250905-000000-db-embedding-modernization/20250905-090000-api-contracts.md`](apps/docs/docs/archive/cold/arch-logs/20250905-000000-db-embedding-modernization/20250905-090000-api-contracts.md).

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

### Performance Test Isolation

Performance tests are separated from functional E2E tests to speed up development:

- **Default behavior**: `pnpm check` and CI run functional tests only
- **Performance tests**: Run on-demand via `pnpm test:e2e:perf` or scheduled daily
- **PR performance testing**: Add `run-perf` label to any PR to trigger performance tests
- **Manual execution**: GitHub Actions → "Performance E2E" → Run workflow

See [`apps/docs/docs/testing/performance-testing.md`](apps/docs/docs/testing/performance-testing.md) for detailed documentation.

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

CI details: `.github/workflows/test.yml` runs lint → type‑check → build (with Tailwind sanity checks) → unit tests with coverage → E2E shards (web + desktop) → report merge.

---

## Contributing

- Install: `pnpm install` at repo root.
- Add deps to a package: `pnpm add <dep> --filter @brainstrike/<pkg>`.
- Create a new package under `apps/` or `packages/`, set a unique `name` in its `package.json`, ensure it matches workspace globs, then run `pnpm install` to link.
- PRs: include tests, keep TypeScript clean, and ensure `pnpm run check` is green locally.

### Dependency Updates

Check for dependency drift and outdated packages across all workspaces:

```bash
pnpm deps:lint
pnpm deps:update:check
pnpm outdated -r
```

Normalize mismatched version ranges across the monorepo:

```bash
pnpm deps:fix
```

Update a specific dependency in a package:

```bash
pnpm update <dep> --filter @brainstrike/<pkg>
```

Update all dependencies with syncpack (writes package.json files; review diffs, then run `pnpm install`):

```bash
pnpm deps:update
```

Helpful docs: `onboarding.md`, `AGENTS.md`, `monorepo-docs.md`.

---

## Troubleshooting

- Node version errors: ensure you’re on Node 22.x (`nvm use` reads `.nvmrc`).
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
