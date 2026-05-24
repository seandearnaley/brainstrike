# BrainStrike Web Application

This directory contains the Vite-powered React application for BrainStrike, a suite of AI-powered productivity tools. It serves as the primary user interface for interacting with the platform's features.

## Quick Start

1.  **Ensure Dependencies are Installed**:
    From the monorepo root, run:
    ```bash
    pnpm install
    ```
2.  **Run the Web App Development Server**:
    From the monorepo root, run:
    ```bash
    pnpm dev --filter @brainstrike/web
    ```
    The application will typically be available at `http://localhost:8080` (or the port specified by the `PORT` environment variable).

## Key Features

-   **File Exploration and Analysis**: Interactive file tree, content preview, and analysis tools.
-   **Report Generation**: Create and export reports based on selected files and project structure.
-   **AI-Powered Insights**: Built-in assistant panel with multi-provider support (OpenAI, Anthropic, Google, OpenRouter) and an optional in-browser local model (WebGPU-only).
-   **Vector Search**: Local PGlite + pgvector with embedding sets, model switching, and tunable HNSW/IVFFlat indexes.
-   **Theming**: Light and dark mode support.
-   **Responsive Design**: Adapts to various screen sizes.

## Development

### Running Locally
To start the development server with hot reloading:
```bash
# From the monorepo root
pnpm dev --filter @brainstrike/web
```
Or, from the `apps/web` directory:
```bash
pnpm dev
```

### Building for Production
To create a production build of the web application:
```bash
# From the monorepo root
pnpm build --filter @brainstrike/web
```
Or, from the `apps/web` directory:
```bash
pnpm build
```
The output files will be located in `apps/web/dist/`.

### Running Tests

-   **Unit and Integration Tests (Vitest)**:
    ```bash
    # From the monorepo root
    pnpm test --filter @brainstrike/web
    ```
    Or, from the `apps/web` directory:
    ```bash
    pnpm test
    ```
-   **End-to-End Tests (Playwright)**:
    E2E tests are defined in `apps/web/e2e/`.
    ```bash
    # From the monorepo root
    pnpm test:e2e
    ```
    To run Playwright tests with the UI mode:
    ```bash
    # From the monorepo root
    pnpm test:e2e:ui
    ```
    To debug E2E tests:
    ```bash
    # From the monorepo root
    pnpm test:e2e:debug
    ```

## Project Structure (`apps/web/src`)

A brief overview of the main entries within `apps/web/src/`:

-   **`app/`**: Page content, layouts, API route stubs, and global CSS. Most user-facing components live here (e.g., `root-layout-content.tsx`, `context-explorer-page-content.tsx`, `settings/`).
-   **`server/`**: Server-side request handlers used by the dev/preview server.
-   **`workers/`**: Web Worker entrypoints owned by the web app.
-   **`types/`**: Web-specific TypeScript type definitions.
-   **`main.tsx`**: The main entry point for the React application.
-   **`vite-env.d.ts`**: TypeScript definitions for Vite environment variables.

Reusable UI components, hooks, and stores are sourced from shared packages (`@brainstrike/ui`, `@brainstrike/hooks`, `@brainstrike/app-shell`, `@brainstrike/preferences`, etc.) rather than living under `apps/web/src/`.

## Environment Variables

-   `PORT`: Port used when starting the development server. Defaults to `8080` if not provided.
-   Other environment variables (e.g., for API endpoints) can be configured via `.env` files. See `.env.example` for a template.

## Contributing

Please refer to the main `README.md` and `AGENTS.md` in the monorepo root for general contribution guidelines, coding standards, and commit message conventions. Ensure that linting, type-checking, and all tests pass before submitting changes.
