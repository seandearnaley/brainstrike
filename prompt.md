You are an expert AI researcher specializing in modern frontend development, monorepos, and React/Electron ecosystems (as of May 2025).

**Objective:** Provide research insights to help an AI assistant plan the migration of UI components and shared logic from a web application (`apps/web`) into dedicated packages (`packages/ui`, `packages/hooks`, `packages/utils`, `packages/types`) within a Turborepo-managed pnpm monorepo. **Crucially, the architecture must support both the current Vite-based web app AND a future Electron application.**

**Core Technologies:**
- React 18+
- TypeScript 5.x (strict mode, `verbatimModuleSyntax`)
- Vite (for the `apps/web` application renderer)
- **Electron (Future Target Platform)**
- Turborepo
- pnpm Workspaces
- Vitest (for unit/integration tests)
- Tailwind CSS + Radix UI (for the `packages/ui` library)
- Biome (linting/formatting)

**Research Questions (Focus on general best practices, patterns, and potential pitfalls as of May 2025, considering BOTH Web and Electron targets):**

1.  **Shared UI Package (`packages/ui`):**
    *   Structuring a React/Tailwind/Radix UI library for consumption by both Vite (web renderer) and Electron (renderer process)? Build targets (CJS/ESM)? `package.json#exports`?
    *   Defining reusable `ComponentProps` for type safety, agnostic to web/Electron differences?
    *   Handling Tailwind CSS for cross-platform consistency?

2.  **Shared Logic Packages (`packages/hooks`, `packages/utils`, `packages/types`):**
    *   Strategies for identifying and extracting reusable hooks/utils suitable for *both* browser and Node.js (Electron main) environments?
    *   Managing/avoiding circular dependencies?
    *   Best practices for shared TypeScript types (`packages/types`) usable across different environments?

3.  **Migration Process & Tooling:**
    *   Common pitfalls in Turborepo migrations *when targeting multiple platforms*?
    *   Vitest strategies for testing shared code in isolation, potentially mocking Electron APIs (`ipcRenderer`, Node modules) vs. Browser APIs?
    *   Optimizing Turborepo pipelines for multi-target builds (web, Electron renderer, Electron main)?

4.  **React 18+ & Vite/Electron Integration:**
    *   Considerations when Vite (web) and Electron's renderer consume shared components/hooks?
    *   Recommended approaches for `React.lazy` dynamic imports in both environments?

5.  **State Management Integration:**
    *   Patterns for shared components/hooks to interact with app-level state (e.g., Zustand, Jotai) via props, independent of web/Electron state management differences (e.g., Electron IPC)?

6.  **Accessibility (a11y):**
    *   Ensuring Radix/Tailwind components meet WCAG standards in both browser and Electron contexts?
    *   Cross-platform a11y testing strategies?

7.  **Performance & Bundle Size:**
    *   Optimizing shared packages for tree-shaking and performance in both Vite and Electron builds?
    *   Strategies for minimizing bundle size impact across platforms?

8.  **Internal Versioning & DX:**
    *   Versioning internal packages (e.g., `changesets`) when supporting multiple app targets?
    *   Using tools like Storybook with Vite/Turborepo for UI development, considering Electron compatibility?

9.  **Electron-Specific Considerations:**
    *   How should shared packages (`hooks`, `utils`) handle logic that needs Node.js APIs (available in Electron main/preload) vs. browser APIs (available in web/Electron renderer)? (e.g., abstraction layers, dependency injection, conditional logic)?
    *   Build tooling recommendations for creating packages compatible with Electron's main process (Node.js environment) vs. its renderer process (browser-like environment)? (e.g., `tsup`, `esbuild`, Vite library mode nuances).
    *   Strategies for managing context isolation and preload scripts when shared code needs to interact between Electron's main and renderer processes?

**Deliverable Format:**
Please provide concise, actionable answers to each numbered research question, citing sources or rationale where appropriate. Focus on patterns, best practices, and potential issues relevant *today* (May 2025), explicitly addressing the dual web/Electron target requirement. Avoid specific code examples unless they illustrate a general principle.