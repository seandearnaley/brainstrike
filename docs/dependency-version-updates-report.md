# Dependency version update report

**Generated:** 2026-06-10\
**Monorepo:** brainstrike (pnpm workspaces + Turborepo)\
**Tooling:** `pnpm@11.5.1+sha512.93f7b57422ea7068257235b4c16eb60762eb68e1dc23723199cc739043ea9be2c4143274a399d8c6defa2b1176226d9ca1c4b63482d6200c1a8fbaa78c1d1485` (see root `package.json` `packageManager`)\
**Node engine (declared):** `24.x` (root `package.json` `engines`)

## Methodology

- Command: `pnpm outdated -r --json` from the repository root (recursive across all workspace packages).
- This compares **direct** dependencies declared in each workspace `package.json` to the **registry latest**; it does not enumerate the full transitive tree.
- Regenerate: `node scripts/generate-dependency-update-report.mjs` (after `pnpm install`).

## Workspace packages (pnpm / Turborepo)

Workspaces follow root `package.json` `workspaces`: `apps/*`, `packages/*` (one level under each).

| Package name | Path | Version | Private |
| --- | --- | --- | --- |
| `@brainstrike/agent` | `packages/agent` | 0.1.0 | yes |
| `@brainstrike/app-shell` | `packages/app-shell` | 0.1.0 | yes |
| `@brainstrike/assistant-contract` | `packages/assistant-contract` | 0.1.0 | yes |
| `@brainstrike/build-utils` | `packages/build-utils` | 0.1.0 | yes |
| `@brainstrike/chunking-worker` | `packages/chunking-worker` | 0.1.0 | yes |
| `@brainstrike/config` | `packages/config` | 0.1.0 | yes |
| `@brainstrike/db` | `packages/db` | 0.1.0 | yes |
| `@brainstrike/db-explorer` | `packages/db-explorer` | 0.1.0 | yes |
| `@brainstrike/desktop` | `apps/desktop` | 0.1.0 | yes |
| `@brainstrike/embedding-worker` | `packages/embedding-worker` | 0.1.0 | yes |
| `@brainstrike/embeddings` | `packages/embeddings` | 0.1.0 | no |
| `@brainstrike/file-explorer` | `packages/file-explorer` | 0.1.0 | yes |
| `@brainstrike/file-explorer-hooks` | `packages/file-explorer-hooks` | 0.1.0 | yes |
| `@brainstrike/file-explorer-ui` | `packages/file-explorer-ui` | 0.1.0 | yes |
| `@brainstrike/file-import` | `packages/file-import` | 0.1.0 | yes |
| `@brainstrike/file-system` | `packages/file-system` | 0.1.0 | no |
| `@brainstrike/file-tree-worker` | `packages/file-tree-worker` | 0.1.0 | yes |
| `@brainstrike/hooks` | `packages/hooks` | 0.1.0 | yes |
| `@brainstrike/indexing-contract` | `packages/indexing-contract` | 0.1.0 | yes |
| `@brainstrike/pipeline` | `packages/pipeline` | 0.0.1 | yes |
| `@brainstrike/platform-utils` | `packages/platform-utils` | 0.1.0 | no |
| `@brainstrike/preferences` | `packages/preferences` | 0.1.0 | yes |
| `@brainstrike/queue` | `packages/queue` | 0.1.0 | yes |
| `@brainstrike/queue-telemetry-collector` | `packages/queue-telemetry-collector` | 0.1.0 | yes |
| `@brainstrike/selection-rules` | `packages/selection-rules` | 0.1.0 | yes |
| `@brainstrike/server-config` | `packages/server-config` | 0.1.0 | yes |
| `@brainstrike/storage` | `packages/storage` | 0.1.0 | no |
| `@brainstrike/tailwind-config` | `packages/tailwind-config` | 0.1.0 | yes |
| `@brainstrike/test-utils` | `packages/test-utils` | 0.1.0 | yes |
| `@brainstrike/text-splitter` | `packages/text-splitter` | 0.1.0 | yes |
| `@brainstrike/token-cache` | `packages/token-cache` | 0.1.0 | yes |
| `@brainstrike/types` | `packages/types` | 0.1.0 | yes |
| `@brainstrike/ui` | `packages/ui` | 1.0.0 | no |
| `@brainstrike/utils` | `packages/utils` | 0.1.0 | yes |
| `@brainstrike/vector-management` | `packages/vector-management` | 0.1.0 | yes |
| `@brainstrike/web` | `apps/web` | 0.1.0 | yes |
| `@brainstrike/worker-runtime` | `packages/worker-runtime` | 0.1.0 | yes |
| `@brainstrike/workers` | `packages/workers` | 0.1.0 | yes |
| `brainstrike` | `.` | 1.0.0 | no |

## How to read this document

- **Current:** version resolved in the lockfile for the listed dependents (aggregated across workspaces).
- **Wanted:** maximum version allowed by the semver range in each declaring `package.json` (may differ per workspace; pnpm lists dependents).
- **Latest:** newest version published to the registry when this report was generated.
- **Bump (current → latest):** `major` / `minor` / `patch` via semver (or `non-semver` for non-standard tags).
- Packages where **current === latest** are omitted from the “Outdated” table unless **deprecated**.

## Summary

| Metric | Count |
| --- | ---: |
| Distinct direct dependencies checked (`pnpm outdated -r`) | 88 |
| Outdated (current ≠ latest) or deprecated | 88 |
| Up to date (current === latest, not deprecated) | 0 |

## Outdated or deprecated packages

| Package | Current | Wanted | Latest | Bump | Type | Deprecated | Dependents |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@ai-sdk/openai` | 3.0.66 | 3.0.66 | 3.0.68 | patch | dependencies | no | @brainstrike/agent |
| `@assistant-ui/react` | 0.12.25 | 0.12.25 | 0.14.15 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@assistant-ui/react-data-stream` | 0.12.11 | 0.12.11 | 0.12.17 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@assistant-ui/react-markdown` | 0.12.9 | 0.12.9 | 0.14.2 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@assistant-ui/styles` | 0.3.7 | 0.3.7 | 0.3.7 | — | devDependencies | yes | @brainstrike/desktop, @brainstrike/web |
| `@babel/core` | 7.29.0 | 7.29.0 | 7.29.7 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@babel/parser` | 7.29.2 | 7.29.2 | 7.29.7 | patch | dependencies | no | @brainstrike/chunking-worker, @brainstrike/db |
| `@babel/plugin-transform-runtime` | 7.29.0 | 7.29.0 | 7.29.7 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@babel/runtime` | 7.29.2 | 7.29.2 | 7.29.7 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@biomejs/biome` | 2.4.12 | 2.4.12 | 2.4.16 | patch | devDependencies | no | @brainstrike/web, brainstrike |
| `@codecov/vite-plugin` | 1.9.1 | 1.9.1 | 2.0.1 | major | devDependencies | no | @brainstrike/web |
| `@commitlint/cli` | 20.5.0 | 20.5.0 | 21.0.2 | major | devDependencies | no | brainstrike |
| `@commitlint/config-conventional` | 20.5.0 | 20.5.0 | 21.0.2 | major | devDependencies | no | brainstrike |
| `@commitlint/types` | 20.5.0 | 20.5.0 | 21.0.1 | major | devDependencies | no | brainstrike |
| `@fontsource-variable/geist` | 5.2.8 | 5.2.8 | 5.2.9 | patch | dependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@fontsource-variable/geist-mono` | 5.2.7 | 5.2.7 | 5.2.8 | patch | dependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@huggingface/transformers` | 4.1.0 | 4.1.0 | 4.2.0 | minor | dependencies | no | @brainstrike/agent, @brainstrike/embedding-worker, @brainstrike/embeddings |
| `@mastra/core` | 1.37.1 | 1.37.1 | 1.41.0 | minor | dependencies | no | @brainstrike/agent |
| `@mastra/mcp` | 1.8.1 | 1.8.1 | 1.9.1 | minor | dependencies | no | @brainstrike/agent |
| `@mastra/memory` | 1.20.0 | 1.20.0 | 1.20.2 | patch | dependencies | no | @brainstrike/agent |
| `@mermaid-js/mermaid-cli` | 11.12.0 | 11.12.0 | 11.15.0 | minor | devDependencies | no | brainstrike |
| `@playwright/test` | 1.59.1 | 1.59.1 | 1.60.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/test-utils, @brainstrike/web, brainstrike |
| `@radix-ui/react-accordion` | 1.2.12 | 1.2.12 | 1.2.13 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@radix-ui/react-checkbox` | 1.3.3 | 1.3.3 | 1.3.4 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@radix-ui/react-dialog` | 1.1.15 | 1.1.15 | 1.1.16 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@radix-ui/react-dropdown-menu` | 2.1.16 | 2.1.16 | 2.1.17 | patch | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-label` | 2.1.8 | 2.1.8 | 2.1.9 | patch | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-popover` | 1.1.15 | 1.1.15 | 1.1.16 | patch | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-progress` | 1.1.8 | 1.1.8 | 1.1.9 | patch | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-scroll-area` | 1.2.10 | 1.2.10 | 1.2.11 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@radix-ui/react-select` | 2.2.6 | 2.2.6 | 2.3.0 | minor | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-slot` | 1.2.4 | 1.2.4 | 1.2.5 | patch | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-switch` | 1.2.6 | 1.2.6 | 1.3.0 | minor | dependencies | no | @brainstrike/ui |
| `@radix-ui/react-tabs` | 1.1.13 | 1.1.13 | 1.1.14 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@radix-ui/react-toast` | 1.2.15 | 1.2.15 | 1.2.16 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@radix-ui/react-tooltip` | 1.2.8 | 1.2.8 | 1.2.9 | patch | dependencies | no | @brainstrike/ui |
| `@shikijs/langs` | 4.0.2 | 4.0.2 | 4.2.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@shikijs/themes` | 4.0.2 | 4.0.2 | 4.2.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@swc/core` | 1.15.30 | 1.15.30 | 1.15.40 | patch | devDependencies | no | @brainstrike/hooks, @brainstrike/selection-rules, @brainstrike/test-utils, @brainstrike/types, @brainstrike/utils |
| `@tailwindcss/vite` | 4.2.2 | 4.2.2 | 4.3.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@tanstack/react-virtual` | 3.13.24 | 3.13.24 | 3.14.2 | minor | dependencies | no | @brainstrike/preferences, @brainstrike/ui, brainstrike |
| `@types/node` | 25.6.0 | 25.6.0 | 25.9.2 | minor | devDependencies | no | @brainstrike/agent, @brainstrike/app-shell, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-explorer-ui, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/platform-utils, @brainstrike/preferences, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/server-config, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/vector-management, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `@types/react` | 19.2.14 | 19.2.14 | 19.2.17 | patch | devDependencies | no | @brainstrike/app-shell, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/file-explorer-hooks, @brainstrike/file-explorer-ui, @brainstrike/file-import, @brainstrike/hooks, @brainstrike/preferences, @brainstrike/test-utils, @brainstrike/token-cache, @brainstrike/ui, @brainstrike/vector-management, @brainstrike/web |
| `@typescript-eslint/parser` | 8.58.2 | 8.58.2 | 8.61.0 | minor | devDependencies | no | brainstrike |
| `@vitejs/plugin-react` | 6.0.1 | 6.0.1 | 6.0.2 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/file-explorer-hooks, @brainstrike/file-explorer-ui, @brainstrike/hooks, @brainstrike/ui, @brainstrike/web |
| `@vitest/browser-playwright` | 4.1.4 | 4.1.4 | 4.1.8 | patch | devDependencies | no | @brainstrike/config, @brainstrike/db, @brainstrike/storage, brainstrike |
| `@vitest/coverage-v8` | 4.1.4 | 4.1.4 | 4.1.8 | patch | devDependencies | no | @brainstrike/desktop, brainstrike |
| `@vitest/ui` | 4.1.4 | 4.1.4 | 4.1.8 | patch | devDependencies | no | @brainstrike/web |
| `assistant-stream` | 0.3.11 | 0.3.11 | 0.3.21 | patch | dependencies | no | @brainstrike/ui |
| `concurrently` | 9.2.1 | 9.2.1 | 10.0.3 | major | devDependencies | no | @brainstrike/desktop |
| `dompurify` | 3.4.0 | 3.4.0 | 3.4.8 | patch | dependencies | no | @brainstrike/web |
| `electron` | 41.2.1 | 41.2.1 | 42.3.3 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/file-system, @brainstrike/storage |
| `electron-builder` | 26.8.1 | 26.8.1 | 26.15.2 | minor | devDependencies | no | @brainstrike/desktop |
| `electron-builder-squirrel-windows` | 26.8.1 | 26.8.1 | 26.15.2 | minor | devDependencies | no | @brainstrike/desktop |
| `eslint` | 10.2.1 | 10.2.1 | 10.4.1 | minor | devDependencies | no | brainstrike |
| `happy-dom` | 20.9.0 | 20.9.0 | 20.10.2 | minor | devDependencies | no | @brainstrike/file-system, @brainstrike/hooks, @brainstrike/platform-utils, @brainstrike/vector-management, brainstrike |
| `jsdom` | 29.0.2 | 29.0.2 | 29.1.1 | minor | devDependencies | no | @brainstrike/app-shell, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/file-explorer-ui, @brainstrike/file-import, @brainstrike/preferences, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/ui, @brainstrike/vector-management, @brainstrike/web |
| `knip` | 5.88.1 | 5.88.1 | 6.16.1 | major | devDependencies | no | brainstrike |
| `lefthook` | 2.1.6 | 2.1.6 | 2.1.9 | patch | devDependencies | no | brainstrike |
| `lucide-react` | 1.8.0 | 1.8.0 | 1.17.0 | minor | devDependencies | no | @brainstrike/file-explorer-ui |
| `mermaid` | 11.14.0 | 11.14.0 | 11.15.0 | minor | devDependencies | no | brainstrike |
| `motion` | 12.38.0 | 12.38.0 | 12.40.0 | minor | dependencies | no | @brainstrike/ui |
| `oxc-parser` | 0.131.0 | 0.131.0 | 0.135.0 | minor | devDependencies | no | @brainstrike/chunking-worker |
| `playwright` | 1.59.1 | 1.59.1 | 1.60.0 | minor | devDependencies | no | @brainstrike/config, @brainstrike/db, @brainstrike/storage, @brainstrike/web, brainstrike |
| `react` | 19.2.5 | 19.2.5 | 19.2.7 | patch | devDependencies | no | @brainstrike/file-import, @brainstrike/test-utils, @brainstrike/token-cache |
| `react-dom` | 19.2.5 | 19.2.5 | 19.2.7 | patch | devDependencies | no | @brainstrike/app-shell, @brainstrike/file-import |
| `react-helmet-async` | 2.0.5 | 2.0.5 | 3.0.0 | major | devDependencies | no | @brainstrike/desktop |
| `react-hotkeys-hook` | 5.2.4 | 5.2.4 | 5.3.2 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `react-resizable-panels` | 4.10.0 | 4.10.0 | 4.11.2 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `react-router-dom` | 7.14.1 | 7.14.1 | 7.17.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/ui |
| `react-shiki` | 0.9.3 | 0.9.3 | 0.10.1 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `shiki` | 4.0.2 | 4.0.2 | 4.2.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `syncpack` | 14.3.0 | 14.3.0 | 15.3.1 | major | devDependencies | no | brainstrike |
| `tailwind-merge` | 3.5.0 | 3.5.0 | 3.6.0 | minor | dependencies | no | @brainstrike/ui |
| `tailwindcss` | 4.2.2 | 4.2.2 | 4.3.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/ui, @brainstrike/web |
| `terser` | 5.46.1 | 5.46.1 | 5.48.0 | minor | devDependencies | no | @brainstrike/web |
| `tsx` | 4.21.0 | 4.21.0 | 4.22.4 | minor | devDependencies | no | @brainstrike/db |
| `turbo` | 2.9.6 | 2.9.6 | 2.9.16 | patch | devDependencies | no | brainstrike |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | major | devDependencies | no | @brainstrike/agent, @brainstrike/assistant-contract, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/config, @brainstrike/db, @brainstrike/desktop, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/indexing-contract, @brainstrike/pipeline, @brainstrike/platform-utils, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `ultracite` | 7.6.0 | 7.6.0 | 7.8.2 | minor | devDependencies | no | brainstrike |
| `vercel` | 50.44.0 | 50.44.0 | 54.10.2 | major | devDependencies | no | brainstrike |
| `vite` | 8.0.8 | 8.0.8 | 8.0.16 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web, brainstrike |
| `vite-plugin-static-copy` | 4.1.0 | 4.1.0 | 4.1.1 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `vitest` | 4.1.4 | 4.1.4 | 4.1.8 | patch | devDependencies | no | @brainstrike/agent, @brainstrike/app-shell, @brainstrike/assistant-contract, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/config, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/indexing-contract, @brainstrike/pipeline, @brainstrike/platform-utils, @brainstrike/preferences, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/vector-management, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `wait-on` | 9.0.5 | 9.0.5 | 9.0.10 | patch | devDependencies | no | @brainstrike/desktop |
| `web-tree-sitter` | 0.25.10 | 0.25.10 | 0.26.9 | minor | dependencies | no | @brainstrike/chunking-worker |
| `zod` | 4.3.6 | 4.3.6 | 4.4.3 | minor | dependencies | no | @brainstrike/agent, @brainstrike/desktop, @brainstrike/selection-rules, @brainstrike/web |
| `zustand` | 5.0.12 | 5.0.12 | 5.0.14 | patch | devDependencies | no | @brainstrike/app-shell, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/preferences, @brainstrike/vector-management, @brainstrike/web |

## Up to date (not listed above)

These packages had **current === latest** and were **not** marked deprecated:



## Related

- [`dependency-updates-breaking-changes.md`](./dependency-updates-breaking-changes.md) — migration notes and changelog pointers for high-risk upgrades.
