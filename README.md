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
  file-explorer/      # Core file explorer state/logic
  file-explorer-ui/   # File explorer UI components
  file-explorer-hooks/# File explorer hooks
  file-system/        # FS abstractions/adapters
  storage/            # Storage abstractions/adapters
  server-config/      # Server config utilities
  tailwind-config/    # Shared Tailwind v4 config
  config/             # Biome + TSConfig
  db/                 # Local DB helpers
  test-utils/, fonts/, workers/, styles/, platform-utils/, embeddings/, file-* ...
```

See also: `onboarding.md` and `monorepo-docs.md` for deep dives.

---

## Queue & Worker (2025)

- Enable: set `EMBED_QUEUE_ENABLED=true` to turn on the DB-backed queue and local worker.
- CLI: `pnpm queue stats`, `pnpm queue requeue -- --queue embeddings --limit 20`, `pnpm queue prune -- --olderThan <ISO> --states succeeded failed`.
- Desktop: starts the embedding worker on app ready when enabled; stops on quit.
- Config: `EMBED_CONCURRENCY`, `EMBED_LEASE_MS`, `EMBED_MODEL_KEY`.

Refer to `docs/PHASE_3_HANDOFF.md` (Post-Review Deltas) and `docs/db-embedding-modernization-2025.md` for the phased plan. API shapes: `docs/api-contracts.md`.

Web UX notes:
- Start/Stop the local worker from Right Panel → DB → Vector Status (no separate Settings controls).
- Worker badge shows `disabled` until explicitly started in the tab, then `running` when jobs are active.

---

## Common Scripts

- `pnpm dev`: Run all dev servers as defined.
- `pnpm build`: Build every workspace (fails if any one fails).
- `pnpm type-check`: Run TypeScript checks across the repo.
- `pnpm lint`: Biome lint (safe fixes on) and `pnpm format` to write formatting.
- `pnpm test`: Vitest unit/integration tests through Turborepo.
- `pnpm test:e2e`: Playwright E2E (web). Desktop E2E: `pnpm test:e2e:desktop`.
- `pnpm clean`: Clean outputs via Turborepo.

Scope to a package with `--filter`, e.g. `pnpm test --filter @brainstrike/utils`.

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

- Index type: set `VECTOR_INDEX_TYPE=ivfflat` to reduce memory (slower but lighter) or rely on default `hnsw` for faster search (higher memory).
- IVFFlat: `IVFFLAT_LISTS=100` controls index granularity; `IVFFLAT_PROBES=8..24` at query time trades recall for speed.
- HNSW: `HNSW_M=16`, `HNSW_EF_CONSTRUCTION=64` tune build memory/quality; `HNSW_EF_SEARCH=32..80` boosts recall at query time.
- Apply by exporting env vars and restarting the app (auto‑migrations will drop/recreate the vector index accordingly).
- Code search quality: smaller code chunks and model‑aware query/doc prompts are enabled. You can adjust the search threshold in the UI; default is configurable via env: `VITE_SEARCH_DEFAULT_THRESHOLD` (web) or `SEARCH_DEFAULT_THRESHOLD`/`BRAINSTRIKE_SEARCH_DEFAULT_THRESHOLD` (desktop/Node). Value is clamped to [0,1].

Notes:
- PGlite + pgvector in WASM benefits from IVFFlat on low‑RAM machines; HNSW is best on desktops with more headroom.
- Vector dimensions are stored per embedding set (`embedding_sets.dimensions`) and validated at runtime. Search queries and chunk writes are scoped by the active set to prevent mixing dimensions. The physical column type may default to `VECTOR(768)`, but the service will guard against mismatches and require using a compatible set for a given model.

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

Helpful docs: `onboarding.md`, `AGENTS.md`, `monorepo-docs.md`.

---

## Troubleshooting

- Node version errors: ensure you’re on Node 22.x (`nvm use` reads `.nvmrc`).
- Playwright prompts: run `pnpm exec playwright install --with-deps chromium` if needed locally.
- Tailwind CSS checks failing in CI: ensure only one `@import "tailwindcss"` per package stylesheet and that the web app scans sources from shared packages; use `TAILWIND_DEBUG=1 pnpm build` to inspect.
- Turborepo caching oddities: `pnpm clean` then retry the command.

---

## License

ISC © BrainStrike contributors. See `LICENSE`.
