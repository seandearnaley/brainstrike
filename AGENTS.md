# Repository Guidelines

## Project Structure & Modules
- Monorepo managed by Turborepo and pnpm.
- Apps in `apps/`: `web` (React/Vite) and `desktop` (Electron).
- Shared packages in `packages/`

## Build, Test, Development
- Install deps: `pnpm install`
- Dev (web): `pnpm dev --filter @brainstrike/web`
- Build all: `pnpm build` (filters `./...`) — every workspace must succeed.
- Lint/Format: `pnpm lint` and `pnpm format`
- Type check: `pnpm type-check`
- Unit/Integration: `pnpm test` or `pnpm test --filter <pkg>`
- E2E (web): `pnpm test:e2e` | UI/debug: `pnpm test:e2e:ui`, `pnpm test:e2e:debug`

## Coding Style & Naming
- TypeScript strict; React 19+ with hooks; Tailwind v4.
- Filenames: kebab-case (`file-explorer.tsx`, `utility-functions.ts`).
- Components: PascalCase exports; file remains kebab-case.
- Hooks: file `use-kebab-case.ts`; export camelCase (`useDataFetcher`).
- Reuse shared packages.

## Testing Guidelines
- Frameworks: Vitest (unit/integration), Playwright (E2E in `apps/web`).
- Naming: `*.test.ts`, `*.integration.test.ts` with source.
- Focus a spec (from pkg dir): `pnpm vitest run -t "name"`.
- CI parity: builds, types, lint, unit/integration, and E2E must pass before PR.

## Commit & PR Guidelines
- Conventional Commits: `<type>(<scope>): <subject>`
  - Types: feat, fix, docs, style, refactor, test, chore, ci, perf, build, revert, release
  - Scopes: auth, api, ui, config, deps, core, test, types, security, dx
- PRs: clear description, linked issues, steps to test, screenshots for UI, note migrations.

## Quality Bar
- Fail fast. No defensive fallbacks or “temporary” workarounds.
- Never downgrade to pass builds; fix root causes properly.
- Use `pnpm turbo run <script> --filter <pkg>` for targeted workflows.

- Do not start dev servers (`dev`, `start`, `serve`) unless explicitly asked. Assume the app/server is running.
- Playwright: run headless; do not modify `playwright.config.*`. Prefer role/text/`data-testid` selectors over CSS.
- Vitest: run per package via `pnpm turbo run test --filter <pkg>`; do not modify `vitest.config.*`.
- Turborepo: prefer `pnpm turbo run <task>` with `--filter` to leverage caching; avoid repo-wide runs unless requested.
- Vite: use per-package `cacheDir`; never share caches across apps/packages to avoid optimize-deps drift.
- Tailwind v4: ensure scanning of `apps/*/src` and `packages/*/src`; avoid excluding them in deploy ignores.
- TypeScript: keep build `compilerOptions.types` explicit (e.g., `["node"]`); do not include test-only types in build configs.
- React compiler/HMR: follow repo rule `react-compiler-and-hmr`; avoid changing hook order/memo shapes; reload on drift.
- Do not edit shared configs (`tailwind.config.*`, `tsconfig.*`, `turbo.jsonc`) without explicit instruction.
- No Implicit fallbacks unless explicitly requested/needed.
- Always timestamp documentation filenames with the date it was written.

# TypeScript Standards for Our Project

## Type safety
- strict mode and `noImplicitAny: true` in tsconfig.
- **Never use `any`.** It defeats type checking and hides errors. If a type cannot be inferred, use `unknown` and narrow it with type guards.
- Always annotate function parameters, return types and object literals.

## Utility types and patterns
- Prefer utility types (`Partial`, `Pick`, etc.) over handcrafted `any` patches.
- Use discriminated unions instead of enums for better exhaustiveness checking.
- Use generics with constraints for reusable functions.

Reasoning: Adhering to these guidelines produces code that is safer, easier to refactor and more compatible with our automated testing and linting pipelines.
