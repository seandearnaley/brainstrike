# Contributor Guide for AI Agents and Developers

Welcome to the `brainstrike` monorepo! This guide is designed to help both human developers and AI agents understand how to effectively contribute to this project.

## Codebase Overview

This is a Turborepo-powered monorepo using `pnpm` as the package manager. The structure is as follows:

*   **`apps/`**: Contains deployable applications.
    *   `web`: The Vite + React implementation of the web application.
*   **`packages/`**: Contains shared code, configuration, and UI components used by applications.
    *   `@brainstrike/ui`: Shared React UI components (based on shadcn/ui & Radix).
    *   `@brainstrike/hooks`: Reusable React hooks.
    *   `@brainstrike/utils`: Common utility functions.
    *   `@brainstrike/types`: Shared TypeScript types and interfaces.
    *   `@brainstrike/config`: Shared configurations (e.g., `tsconfig.json` base, Biome).

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
        pnpm dev --filter web
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
*   **Identifying Package Names**: Package names (e.g., `web`, `@brainstrike/ui`) are found in the `name` field of their respective `package.json` files.
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
*   **State Management (`apps/web`)**: Zustand. For an example, see `apps/web/src/stores/useFileExplorerStore.ts`.
*   **Linting & Formatting**: Biome is used for linting and formatting.
    *   Check for issues:
        ```bash
        pnpm lint
        ```
    *   Format code:
        ```bash
        pnpm format
        ```
    These commands run Biome across the entire monorepo. Ensure your code is compliant before committing.
*   **File & Directory Naming**:
    *   **General**: kebab-case for files and directories (e.g., `my-feature/`, `utility-functions.ts`).
    *   **React Components**: PascalCase for component names (e.g., `UserProfile.tsx`), but kebab-case for filenames (`user-profile.tsx`).
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
            pnpm test --filter web
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
    *   All tests pass (`pnpm test`).
    *   Code is linted and formatted (`pnpm lint` and `pnpm format`).
    *   No type errors (`pnpm type-check`).
    *   PR description clearly explains the changes and reasoning.
    *   New functionality is covered by tests.

## Codebase Migrations & Deprecations

*   *(No active major migrations noted at the moment. This section can be updated as needed.)*
*   When deprecating code, follow established deprecation patterns and update documentation accordingly.

## Validating Changes (Summary)

Before pushing code or opening a PR, ensure:
1.  **Linting**: `pnpm lint` (fix any reported issues).
2.  **Formatting**: `pnpm format` (apply formatting).
3.  **Type Checking**: `pnpm type-check` (resolve all TypeScript errors).
4.  **Testing**: `pnpm test` (all tests should pass). For targeted tests, use filtering as described above.

By following these guidelines, we can maintain a high-quality, consistent, and efficient development workflow for the `brainstrike` project. 