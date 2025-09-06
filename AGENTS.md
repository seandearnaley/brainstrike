# Repository Guidelines

## Project Structure & Modules
- Monorepo managed by Turborepo and pnpm.
- Apps in `apps/`: `web` (React/Vite) and `desktop` (Electron).
- Shared packages in `packages/`: UI (`@brainstrike/ui`), hooks, utils, types, app-shell, file-explorer*, storage, file-system, config, tailwind-config, server-config, test-utils.
- Tests are co-located with sources (e.g., `component.tsx` + `component.test.tsx`).

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
- Indentation: 2 spaces; keep imports/tooling defaults; no stray console logs in prod.
- Filenames: kebab-case (`file-explorer.tsx`, `utility-functions.ts`).
- Components: PascalCase exports; file remains kebab-case.
- Hooks: file `use-kebab-case.ts`; export camelCase (`useDataFetcher`).
- Reuse shared packages (`@brainstrike/ui`, `@brainstrike/hooks`, `@brainstrike/utils`, `@brainstrike/types`).

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
