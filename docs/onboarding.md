# BrainStrike Monorepo - Detailed Onboarding Guide

## 1. Introduction & Vision

Welcome to the BrainStrike monorepo! This project houses a suite of AI-powered productivity tools, built with a modern, scalable, and type-safe architecture. The core philosophy emphasizes modularity, developer experience, and performance, leveraging Turborepo for build orchestration and pnpm for efficient package management.

This document serves as a comprehensive guide for developers, contributors, and automated agents aiming to understand the codebase, architecture, development practices, and contribution guidelines.

**Primary Goals:**
- Deliver high-quality, AI-driven productivity features.
- Maintain a clean, scalable, and maintainable codebase.
- Ensure a smooth and efficient developer workflow.
- Foster collaboration through consistent standards and clear documentation.

---

## 2. Repository Structure Deep Dive

The monorepo uses a standard Turborepo layout, organizing code into `apps` and `packages`.

```
brainstrike/
├── .github/                 # GitHub Actions workflows (CI/CD, etc.) & issue templates
├── .nvmrc                   # Specifies required Node.js version (v22)
├── .turbo/                  # Turborepo build cache (ignored by Git)
├── .vscode/                 # VS Code workspace settings & recommendations
├── apps/
│   ├── desktop/             # Electron application (Playwright E2E lives here)
│   └── web/                 # React/Vite frontend application
│       ├── public/          # Static assets
│       ├── src/             # Application source code (React, Vite, TypeScript)
│       ├── e2e/             # End-to-end tests (Playwright)
│       ├── vite.config.ts   # Vite configuration
│       ├── tsconfig.json    # App-specific TypeScript config
│       └── package.json     # App dependencies and scripts
├── packages/
│   ├── config/              # Shared configuration files (reusable across packages)
│   │   └── tsconfig/        # Shared TypeScript base configurations (base.json, react-library.json)
│   ├── hooks/               # Reusable React hooks
│   ├── types/               # Shared TypeScript interfaces and types
│   ├── ui/                  # Core UI component library (built with React/Tailwind/Radix)
│   └── utils/               # Common utility functions (e.g., date formatting, validation)
├── lefthook.yml             # Git hook automation (pre-commit, commit-msg) managed by Lefthook
├── node_modules/            # Project dependencies (managed by pnpm, ignored by Git)
├── biome.json               # Root Biome configuration for linting and formatting
├── commitlint.config.ts     # Configuration for commit message linting
├── knip.jsonc               # Configuration for Knip (detecting unused files/exports)
├── package.json             # Root project configuration: scripts, devDeps, workspace definition
├── pnpm-lock.yaml           # Exact dependency versions managed by pnpm
├── pnpm-workspace.yaml      # Defines pnpm workspace locations (apps/*, packages/*)
├── README.md                # High-level project overview and quick start
├── tsconfig.json            # Root TypeScript configuration (references workspaces, sets paths)
└── turbo.jsonc              # Turborepo pipeline and task configuration
```

**Key Directories:**
- **`apps/`**: Contains runnable applications (`web` for Vite/React, `desktop` for Electron). Each app is a standalone project within the monorepo.
- **`packages/`**: Houses shared code libraries (UI components, hooks, utilities, types, configurations) consumed by apps or other packages.
- **`packages/config/`**: Centralizes reusable configurations (TypeScript, Biome) to ensure consistency.

---

## 3. Technology Stack & Core Tools

This project utilizes a modern stack focused on performance, type safety, and developer productivity.

- **Build & Orchestration**:
  - **Turborepo `2.7.2`**: Manages the monorepo build system, task execution, and caching. ([`turbo.jsonc`](./turbo.jsonc))
- **Package Management**:
  - **pnpm `10.26.2`**: Efficiently manages dependencies and workspaces. ([`pnpm-workspace.yaml`](./pnpm-workspace.yaml), root [`package.json`](./package.json))
- **Runtime & Language**:
  - **Node.js `v22`**: Specified in [`.nvmrc`](./.nvmrc). Use `nvm use` to switch.
  - **TypeScript `5.9.3`**: Provides static typing across the entire codebase. ([`tsconfig.json`](./tsconfig.json), [`packages/config/tsconfig/base.json`](./packages/config/tsconfig/base.json))
- **Frontend Framework (`apps/web`)**:
  - **React `19.x`**: UI library using functional components and hooks.
  - **Vite**: Next-generation frontend tooling for extremely fast HMR and optimized builds. (See `apps/web/vite.config.ts`)
  - **React Router**: Handles client-side routing. (Setup likely in `apps/web/src/main.tsx` or similar)
  - **`react-helmet-async`**: Manages document head elements (`<title>`, `<meta>`).
- **Testing**:
  - **Vitest `^4.0.14`**: Fast unit and integration testing framework with browser mode support via Playwright, configured for the workspace. ([`vitest.config.mts`](./vitest.config.mts))
  - **Playwright**: Used for End-to-End (E2E) testing within the `apps/web` and `apps/desktop` directories. (See `apps/web/e2e/` and `apps/desktop/e2e/`). See [docs/playwright-ci-optimization.md](./docs/playwright-ci-optimization.md) for our current Playwright guidance.
  - **NYC `17.1.0`**: Generates code coverage reports.
- **Code Quality & Formatting**:
  - **Biome `2.3.8`**: All-in-one tool for linting, formatting, and more, replacing ESLint and Prettier. ([`biome.json`](./biome.json))
- **Commit Linting & Hooks**:
  - **Commitlint `20.1.0`**: Enforces conventional commit message formats using `@commitlint/config-conventional`. ([`commitlint.config.ts`](./commitlint.config.ts))
  - **Lefthook**: Automates pre-commit Biome checks and commit message linting via [`lefthook.yml`](../lefthook.yml).
- **Code Health**:
  - **Knip `5.70.2`**: Detects unused files, dependencies, and exports. ([`knip.jsonc`](./knip.jsonc))

---

## 4. Workspace & Build System Explained

### 4.1 Turborepo (`turbo.jsonc`)

Turborepo orchestrates tasks across the monorepo, optimizing builds through caching and understanding task dependencies.

- **`globalDependencies`**: Changes to `tsconfig.json` will invalidate caches for tasks depending on it.
- **`pipeline`**: Defines the relationships and caching behavior for common scripts (`build`, `lint`, `test`, `dev`, etc.).
  - **`build`**: Depends on the `build` task of its dependencies (`^build`). Outputs generated files to `dist/`.
  - **`lint`**: Depends on `^build`. Caching enabled. No output artifacts expected.
  - **`test`**: Depends on `^build`. Defines specific input file patterns (`src/**/*.ts`, `__tests__/**/*.tsx`, etc.).
  - **`test:coverage`**: Similar to `test` but outputs to `coverage/**`.
  - **`test:e2e`**: Depends on the local `build` task. Outputs reports. Explicitly disables caching (`cache: false`).
  - **`dev`**: Cache disabled (`cache: false`), marked as persistent (`persistent: true`) as it's a long-running process.
  - **`clean`**: Cache disabled.
  - **`type-check`**: Depends on `^build`. Caching enabled.
  - **`coverage:merge` & `coverage:report`**: Custom tasks for aggregating coverage across packages (accepts `--quiet` to reduce output). Cache disabled.

### 4.2 pnpm Workspaces (`pnpm-workspace.yaml`, `package.json`)

pnpm manages dependencies efficiently within the monorepo structure defined in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml).
- **Workspaces**: `apps/*` and `packages/*` are recognized package locations.
- **Root `package.json`**:
  - Defines scripts that use `turbo run ...` to execute tasks across workspaces (e.g., `pnpm build` runs `turbo run build`).
  - Lists root-level `devDependencies` essential for the monorepo tooling (turbo, biome, typescript, commitlint, knip, nyc).
  - Specifies the exact `packageManager` version (`pnpm@10.26.2`).
  - `workspaces` field mirrors `pnpm-workspace.yaml`.
  - `pnpm.onlyBuiltDependencies` might optimize installations for certain native packages.

---

## 5. Code Quality, Style & Conventions

Consistency is maintained through automated tooling.

### 5.1 Biome (`biome.json`)

Biome enforces linting rules and code formatting across the entire monorepo.

**Key Rules & Settings:**
- **Formatting**: Enabled, 2-space indent, 100 line width, single quotes, trailing commas (`es5`), semicolons required. Formats `.ts, .tsx, .js, .jsx, .json`.
- **Imports**: Organized automatically.
- **Linting**: Enabled, uses recommended rules plus specific overrides:
  - `correctness/noUnusedVariables`: `error`
  - `suspicious/noExplicitAny`: `warn` (Discouraged, aim to eliminate)
  - `style/useConst`: `error`
  - `style/useTemplate`: `error`
  - `style/useNamingConvention`: `error` for source code (kebab-case files), but selectively disabled for test files, config files, and E2E directories to allow flexibility (e.g., PascalCase for test fixtures, uppercase for environment variables)
  - `style/useFilenamingConvention`: `error` (strictCase=true, filenames=`kebab-case`)
- **Ignored Files**: `node_modules`, `dist`, `build`, `coverage`, `playwright-report`, `test-results`.

### 5.2 TypeScript (`tsconfig.json`, `packages/config/tsconfig/base.json`)

TypeScript ensures type safety. The root config sets up path aliases and references workspace projects. It extends the base configuration from `packages/config/tsconfig`.

**Key Compiler Options (`base.json`):**
- **Strictness**: `strict: true`, `noImplicitAny: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, etc.
- **Module System**: `module: ESNext`, `moduleResolution: Bundler`, `esModuleInterop: true`.
- **Target**: `ES2020`.
- **JSX**: `react-jsx`.
- **Output**: `declaration: true`, `declarationMap: true`, `sourceMap: true` (for libraries).
- **Checks**: `skipLibCheck: true`.
 - **Paths**: Root `tsconfig.json` defines aliases (`@brainstrike/types`, `@web/*`, `@desktop/*`) for easy cross-package imports.
- **Excludes**: `node_modules`, `dist`, `build`, test files.

### 5.3 Commit Messages (`commitlint.config.ts`)

Commit messages are configured with **liberal rules** to reduce friction. Type prefixes and scopes are **optional**:

- **Flexible Format**: You can write commits as simple as `"Update README"` or follow conventional format `feat(auth): add login`
- **No Required Type**: Type prefixes (`feat`, `fix`, `build`, etc.) are not enforced
- **No Required Scope**: Scopes like `(auth)` are optional
- **Subject**: Should be concise and clear
- **Body/Footer**: Optional for more details or breaking changes/issue references

This flexibility encourages developers to commit more frequently without worrying about format, while still supporting conventional commits for those who prefer the structure. For more details, see [`commitlint.config.ts`](../commitlint.config.ts).

---

## 6. Development Workflow Step-by-Step

1.  **Prerequisites**:
    - Install Node.js v22 (use nvm: `nvm install && nvm use`).
    - Install pnpm globally: `npm install -g pnpm`.
2.  **Clone & Install**:
    ```bash
    git clone <repository-url> brainstrike
    cd brainstrike
    pnpm install # Installs all dependencies for all workspaces
    ```
3.  **Running the Web App (Development Mode)**:
    ```bash
    # Option 1: Run only the web app's dev server
    pnpm dev --filter @brainstrike/web

    # Option 2: Run dev scripts for all packages tagged with 'dev' in turbo.json (if applicable)
    # pnpm dev # This might start multiple processes depending on turbo.json
    ```
    This typically starts the Vite dev server for `apps/web` with Hot Module Replacement (HMR).
4.  **Running Tests**:
    ```bash
    # Run unit/integration tests for all packages
    pnpm test

    # Run tests with coverage for all packages
    pnpm test:coverage

    # Generate a combined coverage report (after running test:coverage)
    pnpm coverage:merge -- --quiet # omit --quiet for verbose output
    pnpm coverage:report # Report saved in ./coverage

    # Run E2E tests (requires the web app to be built or running)
    # Ensure the web app is built first: pnpm build --filter @brainstrike/web
    pnpm test:e2e # Runs Playwright tests defined in apps/web/e2e

    # Run E2E tests with Playwright UI mode
    pnpm test:e2e:ui

    # Debug E2E tests
    pnpm test:e2e:debug
    ```
5.  **Linting and Formatting**:
    ```bash
    # Check for lint errors and formatting issues and apply safe fixes
    pnpm lint

    # Format all files
    pnpm format
    ```
6.  **Type Checking**:
    ```bash
    # Run TypeScript compiler across all packages to check for type errors
    pnpm type-check
    ```
7.  **Building for Production**:
    ```bash
    # Build all apps and packages according to the turbo pipeline
    pnpm build
    ```
8.  **Cleaning Build Artifacts**:
    ```bash
    # Remove build outputs (dist, etc.) and turbo cache
    pnpm clean
    ```
9.  **Checking for Unused Code**:
    ```bash
    # Run Knip to find unused files, dependencies, and exports
    pnpm knip
    ```

---

## 7. System Architecture & Integrations

- **Monorepo Strategy**: Utilizes Turborepo and pnpm workspaces for managing dependencies and orchestrating builds/tests across multiple packages and applications efficiently.
- **Frontend Architecture (`apps/web`)**: A standard Vite + React Single Page Application (SPA). State management solution (Context, Zustand, Redux?) should be documented if applicable. Component architecture likely follows standard React patterns.
 - **Shared Packages**: Core logic, UI elements, types, and utilities are extracted into `packages/*` to promote code reuse and maintainability. Path aliases (`@brainstrike/*`, `@web/*`, `@desktop/*`) simplify imports.
- **Configuration Management**: Shared configurations (`packages/config`) ensure consistency in tooling (TypeScript, Biome) across the repository.
- **Testing Strategy**:
  - **Unit/Integration**: Vitest is used for fast testing, colocated within `src/` or `__tests__` directories.
  - **E2E**: Playwright tests user flows directly in the browser (`apps/web/e2e/`).
  - **Coverage**: NYC aggregates coverage data from Vitest runs across packages.
- **CI/CD**: GitHub Actions workflows (`.github/workflows`) likely handle automated testing, linting, building, and potentially deployment on pushes/PRs. (Specific workflow details should be checked in the `.github` folder).
- **Git Hooks**: Lefthook (`lefthook.yml`) ensures code quality checks (Biome and commitlint) run automatically before commits or pushes.
- **File Explorer Adapter Pattern**: Storage and file system logic is abstracted behind `@brainstrike/storage` and `@brainstrike/file-system`. Adapters for web, memory, and mock implementations allow the explorer to run in browsers, tests, or future Electron apps without changing core code.

---

## 8. Contribution Guidelines

1.  **Branching**: Create feature branches from `main` (or `develop` if used). Use descriptive names (e.g., `feat/user-authentication`, `fix/login-button-bug`).
2.  **Code Style**: Adhere strictly to Biome rules (`pnpm lint --fix` and `pnpm format`).
3.  **Type Safety**: Ensure code passes TypeScript checks (`pnpm type-check`). Eliminate `any` types where possible.
4.  **Testing**: Add relevant unit, integration, or E2E tests for new features or bug fixes. Aim for high test coverage. Ensure all tests pass (`pnpm test`, `pnpm test:e2e`).
5.  **Commit Messages**: Follow the Conventional Commits standard (enforced by `commitlint`). Use `git commit -m "type(scope): subject"` format.
6.  **Pull Requests**: Submit PRs to `main` (or `develop`). Provide a clear description of changes, link related issues, and ensure CI checks pass.
7.  **Dependencies**: Add dependencies to the specific `package.json` of the app or package where they are needed, not the root unless it's a root-level tool. Run `pnpm install` after modifying dependencies.

---

## 9. Troubleshooting & Common Issues

- **Dependency Issues**: Run `pnpm install` after pulling changes or switching branches. If issues persist, try removing `node_modules` and reinstalling: `pnpm clean && rm -rf node_modules && pnpm install`.
- **Type Errors**: Ensure all dependencies are built (`pnpm build`) as type generation relies on built artifacts (`.d.ts` files). Check `tsconfig.json` configurations.
- **Cache Problems**: If builds or tests behave unexpectedly, clear the Turborepo cache: `pnpm clean` or manually delete `.turbo`.
- **Biome/Lint Errors**: Run `pnpm format` to fix formatting. Check rule violations reported by `pnpm lint` against the Biome configuration.
- **Hook Errors (Git)**: Ensure Lefthook hooks are installed (`pnpm exec lefthook install`).

---

This document provides a deep dive into the BrainStrike monorepo. For further details, consult the configuration files directly or explore the codebase within specific packages and apps. Happy coding!
