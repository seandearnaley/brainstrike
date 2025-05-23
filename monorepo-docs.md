# BrainStrike Monorepo: Deep Technical Guide for Component Extraction & Migration

## 1. Monorepo Overview

BrainStrike is a modern, modular monorepo built for AI-powered productivity tools. It leverages **Turborepo** for orchestrated builds, **pnpm** for workspace-aware package management, and a strict separation between application code (`apps/`) and reusable libraries (`packages/`).

- **Apps**: Contains deployable applications (e.g., `apps/web` is the main Vite + React frontend).
- **Packages**: Houses shared code—UI components (`ui`), hooks, types, utilities, and configuration.
- **Build & CI**: Turbo pipelines (`turbo.jsonc`) ensure fast, cacheable, and ordered builds/tests/lints across all workspaces.

## 2. Directory & Workspace Structure

```
brainstrike/
├── apps/
│   └── web/          # Main Vite + React app (see src/ for components/pages)
├── packages/
│   ├── ui/           # Canonical UI library (React + Tailwind components)
│   ├── hooks/        # Reusable React hooks
│   ├── types/        # Shared TypeScript types/interfaces
│   ├── utils/        # Utility functions
│   └── config/       # Shared config (tsconfig, biome, etc)
├── turbo.jsonc       # Turborepo pipeline config
├── pnpm-workspace.yaml # pnpm workspace definition
├── package.json      # Root scripts, devDeps, workspace definition
├── tsconfig.json     # Root TS config (references packages/app configs)
├── onboarding.md     # In-depth onboarding & architectural rationale
├── README.md         # Quick start and migration notes
└── ...
```

- **All packages and apps are first-class workspaces.**
- **No cross-imports between apps—only apps import from packages.**
- **Shared config** (e.g., Biome, TS) is centralized in `packages/config`.

## 2.1 apps/web/src: Anatomy & Migration Considerations

Detailed breakdown of the application code structure and key pointers for extraction:

**apps/web/src/**
```
├── app/            # Root layouts, page wrappers (uses React Helmet, imports globals.css)
├── components/     # Local UI components
│   ├── Presentational (buttons, dialogs, inputs)
│   └── custom/     # Feature modules (file-explorer)
├── hooks/          # App-specific hooks (data fetching, selectors, side-effects)
├── stores/         # Global state stores, actions, persistence logic
├── lib/            # Core services (API clients, git analysis logic)
├── utils/          # Pure helper functions (formatters, validators)
├── providers/      # React context providers (Theme, Toast, Auth)
├── constants/      # Enums and literal values
└── icons/          # SVG icon components
```

**Migration Guidance per folder:**
- **app/**: Entry-point logic; refactor layouts/pages to consume migrated components via props/hooks.
- **components/**: Split container (data logic) vs presentational. Move pure UI to `packages/ui`, containers to `packages/hooks` or new domain packages.
- **hooks/**: Migrate to `packages/hooks`, ensure generic API signatures and remove UI dependencies.
- **stores/**: Extract domain stores into `packages/hooks` (or new `packages/store-<domain>`), isolate persistence logic.
- **lib/**: Consider moving to `packages/utils` or create specialized package (e.g., `packages/analysis`) for heavy business logic.
- **utils/**: Directly migrate pure functions to `packages/utils` with minimal changes.
- **providers/**: Generic providers can live in `packages/ui` or a new `packages/providers`; app-specific setup stays in app.
- **constants/**: Move shared types and enums to `packages/types`, use type-only imports.
- **icons/**: Migrate atomic icon components to `packages/ui/icons`.

**Key Migration Considerations:**
- **UI vs Logic**: Always separate presentational components from stateful/container logic before extraction.
- **Type-only imports**: Centralize interfaces/constants in `packages/types` and use `import type`.
- **Dependency discovery**: Use `grep_search` or IDE search to identify cross-folder imports and external dependencies.
- **Domain packages**: For complex features (analysis, file-explorer), consider dedicated packages rather than forcing into `ui`.
- **Peer dependency sync**: Ensure React, Tailwind, and other peer deps match across migrated packages via package.json alignment.

## 3. Turborepo Pipeline & Task Conventions

- **Builds** are topologically ordered (libs before apps) and cacheable (`dist/**` outputs).
- **Tests** run after builds, outputting coverage and results for caching.
- **Lint** and **type-check** are required for all packages/apps (see `turbo.jsonc`).
- **Dev** tasks are persistent (for local dev servers/watchers).
- **Composite `check` task** runs lint, type-check, and test for CI and local validation.

**Key scripts:** (from root `package.json`)
- `pnpm install` — install all dependencies
- `pnpm dev` — start all dev servers/watchers
- `pnpm build` — full build across all workspaces
- `pnpm test` — run all tests
- `pnpm turbo run lint` — run linter
- `pnpm lint --fix` — auto-fix lint issues using Biome
- `pnpm turbo run type-check` — run type checks

## 4. Component Extraction & Migration Workflow

This repo is designed for extracting UI (and other) components from `apps/web` into canonical packages (usually `packages/ui`).

### **Migration Steps (Best Practice)**

1. **Identify Component**
   - Locate the component in `apps/web/src` (or other app source).
   - Review all usages, props, and dependencies.

2. **Extract to Package**
   - Create a new file in `packages/ui/src/<Component>.tsx` (or appropriate package).
   - Refactor:
     - Remove app-specific imports (stores, utils, hooks not meant for UI lib).
     - Define a `Props` interface for all inputs/callbacks.
     - Ensure component is pure and only uses props/state.
   - Export as a named export in `packages/ui/src/index.ts`.

3. **Move/Update Tests**
   - Move or duplicate tests to `packages/ui/src/__tests__`.
   - Update imports to use named exports from `@brainstrike/ui`.
   - Ensure `import React` and `import '@testing-library/jest-dom'` are present.
   - Use type-only imports for props where possible.

4. **Update App Imports**
   - Replace all local imports in `apps/web` with `import { Component } from '@brainstrike/ui'`.
   - For dynamic imports, cast to `React.ComponentType` if needed.
   - Pass all required props from app state/store.

5. **Validation**
   - Run `pnpm build`, `pnpm test`, and `pnpm turbo run type-check` across all workspaces.
   - Fix any errors or type issues.

6. **Cleanup**
   - Use code search (`grep`, IDE, or `turbo run lint`) to ensure no references remain to the old component file.
   - Add a deprecation comment to the old file before deleting.
   - Remove the old file and any related test/mocks/utilities.
   - Re-run all CI steps to confirm a clean migration.

**See also:**
- [Component Migration Memory](#)
- [UI Migration and Test Cleanup Lessons Learned](#)

## 5. Shared UI Library (`@brainstrike/ui`)

- Built with Shadcn UI + Tailwind CSS v4.
- Components are pure, stateless, and receive all data via props.
- Usage:

```jsx
import { Button, Input } from '@brainstrike/ui';
<Button variant="default">Click</Button>
```

- Add `@brainstrike/ui/globals.css` after Tailwind in your app's CSS.
- See `packages/ui/README.md` for full setup and component list.

## 6. Testing, Linting, and Type Safety

- **Vitest** is used for unit/integration tests (see `vitest.workspace.ts`).
- **Playwright** for E2E tests (`apps/web/e2e`).
- **NYC** aggregates coverage from all packages/apps.
- **Biome** is used for linting and formatting (see `biome.json`).
- **Strict TypeScript** everywhere; shared types live in `packages/types`.

### 6.1 Mocking Workspace Packages

When writing tests that import other workspace packages (for example,
`@brainstrike/hooks` consuming components from `@brainstrike/ui`), avoid
calling `importOriginal` inside the mock factory. This can load multiple
copies of a module and break interdependent mocks. Instead, define
hoisted mocks using `vi.hoisted` so mock exports are available before
`vi.mock` runs.

```ts
const { mockUseFoo } = vi.hoisted(() => ({
  mockUseFoo: vi.fn(),
}));
vi.mock('@brainstrike/hooks', () => ({
  useFoo: mockUseFoo,
}));
```

Hoisted mocks keep tests deterministic and are recommended whenever
mocking packages like `@brainstrike/hooks` and `@brainstrike/ui`.

## 7. Key Conventions & Gotchas

- **Never import app code into packages.** Packages must remain decoupled.
- **Always update all imports and mocks before deleting migrated files.**
- **Use code search to confirm no remaining references before cleanup.**
- **Mock both components and hooks in tests if needed.**
- **Add clear deprecation comments before deleting old files.**

## 8. Quick Reference: Common Tasks

| Task                        | Command                          |
|-----------------------------|----------------------------------|
| Install deps                | `pnpm install`                   |
| Start dev server (web)      | `cd apps/web && pnpm dev`        |
| Build all                   | `pnpm build`                     |
| Test all                    | `pnpm test`                      |
| Lint all                    | `pnpm turbo run lint`             |
| Fix lint issues             | `pnpm lint --fix`             |
| Type-check all              | `pnpm turbo run type-check`      |

## 9. Further Reading
- `onboarding.md`: Deep-dive onboarding, architecture, and rationale
- `packages/ui/README.md`: UI library usage and setup
- `turbo.jsonc`: Turborepo pipeline config
- `pnpm-workspace.yaml`: Workspace/project boundaries
- `biome.json`: Lint/format rules

---

**This document is self-contained and should serve as the primary reference for component extraction and migration in the BrainStrike monorepo. For architectural decisions and onboarding, see `onboarding.md`.**
