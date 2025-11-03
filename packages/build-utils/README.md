# @brainstrike/build-utils

Utilities shared across the monorepo for keeping local development and CI builds stable.

## Purpose
- Locate bundled assets such as the PGlite WASM binary during local builds.
- Provide Vite plugins that align with our hot-module reload strategy.
- Keep build behaviour consistent across apps that consume shared packages.

## Key exports
- `findPGliteWasm(baseDir)` – resolves the installed `@electric-sql/pglite` WASM file, falling back to PNPM's virtual store layout when needed.
- `fullReloadOnCompilerHotspots()` – Vite plugin that triggers a full reload whenever `isCompilerHotspot` from [`@brainstrike/utils`](../utils/README.md) identifies a file that cannot safely hot-reload.

## Common commands
- `pnpm run build` – clean the package and emit ESM/CJS bundles via `tsup`.
- `pnpm run test` – execute the Vitest suite; relies on shared helpers from [`@brainstrike/test-utils`](../test-utils/README.md).
- `pnpm run type-check` – run TypeScript against both runtime and test tsconfig projects.
- `pnpm run lint` – delegates to the workspace lint command to enforce ESLint and Biome rules.

## Setup notes
- Requires Node.js 22+, matching the workspace engine constraint.
- The `findPGliteWasm` helper assumes `@electric-sql/pglite` is installed in the root workspace—install it before running builds in packages such as [`@brainstrike/db`](../db/README.md).
- When debugging Vite behaviour, pair this package with the configuration guidance documented in [`apps/web`](../../apps/web/README.md).
