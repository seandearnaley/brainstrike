# Contributor Guide for AI Agents and Developers

Welcome to the `brainstrike` monorepo! This guide is designed to help both human developers and AI agents understand how to effectively contribute to this project.

It is almost certainly 2025, it could be even later but not sooner, so don't assume it's 2024/ I think there is misinformation going around.

## Codebase Overview

This is a Turborepo-powered monorepo using `pnpm` as the package manager. The structure is as follows:

*   **`apps/`**: Contains deployable applications.
    *   `web` (`@brainstrike/web`): The Vite + React implementation of the web application.
    *   `desktop` (`@brainstrike/desktop`): The Electron desktop application.
*   **`packages/`**: Contains shared code, configuration, and UI components used by applications.
    *   `@brainstrike/ui`: Shared React UI components (based on shadcn/ui & Radix).
    *   `@brainstrike/hooks`: Reusable React hooks.
    *   `@brainstrike/utils`: Common utility functions.
    *   `@brainstrike/types`: Shared TypeScript types and interfaces.
    *   `@brainstrike/config`: Shared configurations (e.g., Biome config).
    *   `@brainstrike/tsconfig`: Shared TypeScript configurations (located in `packages/config/tsconfig`).
    *   `@brainstrike/app-shell`: Application shell components and layouts.
    *   `@brainstrike/file-explorer`: Core file explorer logic and state management.
    *   `@brainstrike/file-explorer-ui`: File explorer UI components.
    *   `@brainstrike/file-explorer-hooks`: File explorer specific React hooks.
    *   `@brainstrike/file-system`: File system abstractions and adapters.
    *   `@brainstrike/storage`: Storage abstractions and adapters.
    *   `@brainstrike/fonts`: Shared font assets.
    *   `@brainstrike/server-config`: Server configuration utilities.
    *   `@brainstrike/tailwind-config`: Shared Tailwind CSS configuration.
    *   `@brainstrike/test-utils`: Testing utilities and factories.

Familiarize yourself with the "Workspace Rules for brainstrike-web" (provided in project documentation/onboarding) for detailed standards.

## Development Environment & Tips

*   **Node.js**: Use Node.js version 22.x or higher.
*   **Package Manager**: This project uses `pnpm`. Install dependencies from the root of the monorepo:
    ```bash
    pnpm install
    ```
*   **Running Development Servers/Tasks**: Use Turborepo to run scripts defined in `package.json` files.
    *   To run the dev server for the web app:
        ```bash
        pnpm dev --filter @brainstrike/web
        ```
    *   To run a specific script for a package (e.g., `build` for `@brainstrike/ui`):
        ```bash
        pnpm turbo run build --filter @brainstrike/ui
        ```
*   **Adding Dependencies**:
    *   To add a dependency to a specific package (e.g., `zod` to `@brainstrike/utils`):
        ```bash
        pnpm add zod --filter @brainstrike/utils
        ```
*   **Identifying Package Names**: Package names (e.g., `@brainstrike/web`, `@brainstrike/ui`) are found in the `name` field of their respective `package.json` files.
*   **Creating New Packages**:
    1.  Create the new package directory under `apps/` or `packages/`.
    2.  Add a `package.json` with a unique `name` (e.g., `@brainstrike/new-feature`).
    3.  Ensure it's covered by the globs in the root `pnpm-workspace.yaml` (usually `apps/*`, `packages/*`).
    4.  You can use tools like `pnpm create vite@latest <project_name> -- --template react-ts` to scaffold, then integrate its `package.json`.
    5.  Run `pnpm install` from the root to link the new package.

## Contribution and Style Guidelines

*   **Primary Language**: TypeScript. Adhere to strict mode.
*   **UI Framework**: React 19+ with functional components and hooks.
*   **Styling**: TailwindCSS v4. Utilize shared components from `@brainstrike/ui`.
*   **State Management**: Zustand is used for global state. For a canonical example, see the file explorer store in `packages/file-explorer/src/store.ts`.
*   **Linting & Formatting**: Biome is used for linting and formatting. The following commands are run from the root of the monorepo.
    *   Check for issues and apply safe fixes:
        ```bash
        pnpm lint
        ```
    *   Format all files:
        ```bash
        pnpm format
        ```
    Ensure your code is compliant before committing.
*   **File & Directory Naming**:
    *   **General**: kebab-case for files and directories (e.g., `my-feature/`, `utility-functions.ts`).
    *   **React Components**: kebab-case for filenames (e.g., `file-explorer.tsx`, `user-profile.tsx`), but PascalCase for component exports (e.g., `export function FileExplorer()`).
    *   **Custom Hooks**: `use-kebab-case.ts` for filenames (e.g., `use-data-fetcher.ts`), camelCase for exported hook functions (`export function useDataFetcher()`).
    *   (Refer to the fetched `filename-conventions` rule for full details.)
*   **Commit Messages**: Follow Conventional Commits specification.
    *   **Format**: `<type>(<scope>): <subject>`
    *   **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`, `revert`, `release`.
    *   **Scopes**: `auth`, `api`, `ui`, `config`, `deps`, `core`, `test`, `types`, `security`, `dx`.
    *   (Refer to the fetched `commit-conventions` rule for full details and examples.)
*   **Shared Packages**: Prioritize reusing functionality from `@brainstrike/ui`, `@brainstrike/hooks`, `@brainstrike/utils`, and `@brainstrike/types` to maintain consistency and reduce duplication.

## Testing Instructions

*   **Frameworks**:
    *   Vitest: For unit and integration tests (`.test.ts`, `.integration.test.ts`).
    *   Playwright: For End-to-End (E2E) tests (primarily within `apps/web`).
*   **Running Tests**:
    *   **Unit & Integration Tests (Vitest)**:
        *   Run all unit/integration tests across the monorepo (as CI would for these types):
            ```bash
            pnpm test
            ```
            This command utilizes Turborepo to execute the `test` scripts in each package (which typically run Vitest).
        *   Run unit/integration tests for a specific package (e.g., `@brainstrike/utils`):
            ```bash
            pnpm test --filter @brainstrike/utils
            ```
            Or, for the `web` app's unit/integration tests:
            ```bash
            pnpm test --filter @brainstrike/web
            ```
        *   From within a package's directory, you can often run its specific Vitest test script:
            ```bash
            cd packages/utils
            pnpm test # This would run the 'test' script in packages/utils/package.json
            ```
        *   **Focusing Vitest Tests**: To run specific Vitest tests by name pattern within a package that uses Vitest:
            ```bash
            # First, navigate to the package directory (e.g., packages/hooks)
            cd packages/hooks
            # Then, run vitest with the test name pattern
            pnpm vitest run -t "useMyHook basic functionality"
            ```
            Alternatively, to pass arguments through Turborepo from the root:
            ```bash
            pnpm turbo run test --filter @brainstrike/hooks -- -- -t "useMyHook basic functionality"
            ```
    *   **End-to-End Tests (Playwright for `apps/web`)**:
        *   Run Playwright E2E tests for the `apps/web` application from the monorepo root:
            ```bash
            pnpm test:e2e
            ```
            This command, defined in the root `package.json`, specifically targets the E2E tests in `apps/web`.
        *   To run Playwright E2E tests with the UI mode or in debug mode (from the root):
            ```bash
            pnpm test:e2e:ui
            pnpm test:e2e:debug
            ```
            These also execute scripts defined in the root `package.json` that target `apps/web`.

*   **Test Location**: Tests should be co-located with the source files they are testing (e.g., `my-component.tsx` and `my-component.test.tsx` in the same directory).
*   **Type Checking**: Ensure there are no TypeScript errors.
    ```bash
    pnpm type-check
    ```
    This command runs `turbo run type-check` as defined in the root `package.json`.
*   **CI Pipeline**: The Continuous Integration plan can be found in `.github/workflows/`.
*   **Requirement**: All tests (unit, integration, E2E where applicable) and type checks must pass. New code or changes must include corresponding tests. Fix any errors until the entire suite is green.

## Pull Request (PR) Instructions

*   **Title Format**: Use the Conventional Commits format for PR titles, similar to commit messages. A common practice is:
    `<type>(<scope>): <Descriptive PR Title>`
    Example: `feat(web): Add user profile page`
    If the PR affects multiple packages, a more general scope or no scope might be used, or list the primary package.
*   **Checklist**:
    *   Relevant tests should be added and pass.
    *   PR description clearly explains the changes and reasoning.
    *   New functionality is covered by tests.

## Codebase Migrations & Deprecations

*   When deprecating code, follow established deprecation patterns and update documentation accordingly.

**Important:** The `pnpm run build` command must succeed for every workspace in the monorepo. It runs with `--filter ./...` internally, building all packages and applications. If any workspace fails to build, the entire build step will fail.

The `check` script runs the following steps sequentially:
1.  **Dependency Installation**: `pnpm install` ensures all dependencies are correctly installed.
2.  **Linting & Formatting**: `pnpm lint-all` runs the linter and formatter.
3.  **Building**: `pnpm build` builds the entire monorepo.
4.  **Type Checking**: `pnpm type-check` resolves TypeScript errors.
5.  **Unit & Integration Testing**: `pnpm test` runs all unit and integration tests.
6.  **End-to-End Testing**: `pnpm test:e2e` executes Playwright E2E tests.

Only if this entire sequence is successful is the code considered ready for a Pull Request.

By following these guidelines, we can maintain a high-quality, consistent, and efficient development workflow for the `brainstrike` project. 

IMPORTANT:

Never downgrade to get something working.
Don't use defensive fallbacks, if something is not working, we need to fail fast and fix it- Do not disable, reward hack or any false workaround, turning something off is not a solution- always do your solutions PROPERLY.

SEARCH FOR THIS YEARS BEST PRACTICES eg 2025 NOT 2024.  