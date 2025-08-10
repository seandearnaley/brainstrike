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
│   ├── storage/      # Cross-platform storage adapters
│   ├── file-system/  # Cross-platform file system adapters
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

## 2.1 apps/web/src: Current Structure

The `apps/web/src` directory has been significantly streamlined. Most of the original UI components, hooks, and utilities have been extracted into their respective `packages/` libraries, following the migration strategy this document once outlined.

The current structure is lean, primarily containing application-level setup and routing.

**apps/web/src/**
```
├── __tests__/      # Tests for application-level utilities (e.g., csp-utils.ts)
├── app/            # Core application routing, layouts, and pages
│   ├── __tests__/  # Tests for layouts and pages
│   ├── settings/   # Components for the settings page
│   ├── globals.css # Global styles imported into the application
│   ├── layout.tsx  # The root layout component
│   └── ...         # Other page-level components
├── csp-utils.ts    # Content Security Policy utilities
├── main.tsx        # The main entry point for the React application
└── vite-env.d.ts   # Vite-specific TypeScript environment types
```

**Architectural Note:**
This structure reflects a mature state of the monorepo where the `web` app acts as a consumer and integrator of shared packages rather than a monolithic source of components and logic. Any new, reusable functionality should be developed within a suitable package from the start.

## 3. Turborepo Pipeline & Task Conventions

- **Builds** are topologically ordered (libs before apps) and cacheable (`dist/**` outputs).
- **Tests** run after builds, outputting coverage and results for caching.
- **Lint** and **type-check** are required for all packages/apps (see `turbo.jsonc`).
- **Dev** tasks are persistent (for local dev servers/watchers).
- **Composite `check` task** runs lint, type-check, and test for CI and local validation.

**Key scripts:** (from root `package.json`)
- `pnpm install` — Install all dependencies.
- `pnpm dev --filter <app-name>` — Start a dev server for a specific app (e.g., `@brainstrike/web`).
- `pnpm build` — Build all packages and applications.
- `pnpm test` — Run all unit and integration tests.
- `pnpm lint` — Check for lint errors and apply safe fixes.
- `pnpm format` — Format all source files.
- `pnpm type-check` — Run TypeScript type checks across the monorepo.
- `pnpm check` — Run the full validation pipeline (lint, build, type-check, test, etc.).

## 4. Guiding Principles for Code Extraction

While the initial large-scale migration of components from `apps/web` to `packages/` is complete, the principles behind it remain relevant for ongoing development. This section serves as a guide for maintaining the modular architecture.

### **Best Practices for New Development**

- **Default to `packages`**: New, potentially reusable logic, components, or types should be created within an appropriate shared package from the start, rather than in `apps/web`.
- **Single Responsibility**: Packages should have a clear and focused purpose (e.g., UI components, hooks, type definitions).
- **App as Integrator**: The `apps/web` application should primarily consume and integrate functionality from the shared `packages/`. Avoid adding complex business logic or reusable components directly to the app.

### **Workflow for Extracting Existing Code**
If you identify code within an app that should be shared, follow this workflow:

1.  **Identify and Isolate**: Locate the component, hook, or utility in the app source. Refactor it to be self-contained, removing any app-specific dependencies or state management logic. All communication should be through props or function arguments.
2.  **Move to a Package**:
    *   Create a new file in the appropriate package (e.g., `packages/ui/src/new-component.tsx`).
    *   Add a corresponding test file (e.g., `packages/ui/src/__tests__/new-component.test.tsx`).
    *   Export the new module from the package's main entry point (e.g., `packages/ui/src/index.ts`).
3.  **Update Consumers**: Refactor the original app code to import and use the new module from the shared package.
4.  **Validate**: Run the full check suite (`pnpm check`) to ensure the change hasn't introduced any regressions, type errors, or lint issues.
5.  **Cleanup**: Once validated, remove the old file from the app's source code.

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

- **Vitest** is used for unit/integration tests (see `vitest.config.ts`).
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
| Install dependencies        | `pnpm install`                   |
| Start dev server (web)      | `pnpm dev --filter @brainstrike/web` |
| Build all packages          | `pnpm build`                     |
| Test all packages           | `pnpm test`                      |
| Lint & fix issues           | `pnpm lint`                      |
| Format code                 | `pnpm format`                    |
| Type-check all packages     | `pnpm type-check`                |
| Run full validation suite   | `pnpm check`                     |

## 9. Further Reading
- `onboarding.md`: Deep-dive onboarding, architecture, and rationale
- `packages/ui/README.md`: UI library usage and setup
- `turbo.jsonc`: Turborepo pipeline config
- `pnpm-workspace.yaml`: Workspace/project boundaries
- `biome.json`: Lint/format rules

---

**This document is self-contained and should serve as the primary reference for component extraction and migration in the BrainStrike monorepo. For architectural decisions and onboarding, see `onboarding.md`.**
