# @brainstrike/config

Shared configuration assets (TS configs, Biome presets, Playwright helpers) that keep tooling aligned across the monorepo.

## Purpose
- Distribute a single source of truth for TypeScript compiler options.
- Provide Biome/ESLint config that mirrors the repository-wide lint expectations.
- Expose Playwright environment helpers used by [`apps/web`](../../apps/web/README.md) and [`apps/desktop`](../../apps/desktop/README.md).

## Key exports
- `./tsconfig/*` – layered `tsconfig` presets consumed by packages like [`@brainstrike/file-import`](../file-import/README.md).
- `./biome` – Biome configuration shared across the repo.
- `./playwright-environment` – environment detection utilities (see `src/playwright-environment.ts`) that Playwright configs import to tune worker counts and retries.

## Common commands
- `pnpm run test` – executes Vitest for the environment utilities.
- `pnpm run type-check` – validates both runtime and test TypeScript configs; run when adjusting compiler presets.
- `pnpm run lint` – delegates to the workspace lint workflow to keep the configuration files formatted.

## Setup notes
- Requires Node.js 22+ so the same runtime assumptions apply to all packages.
- The Playwright helpers respect CI-specific variables (`CODEX_ENV`, `GITHUB_ACTIONS`, `CI`). Mirror these when running headless tests locally.
- When tweaking configs, update the consumer references in `tsconfig.json` files (for example [`packages/storage/tsconfig.json`](../storage/tsconfig.json)) so the workspace stays in sync.
