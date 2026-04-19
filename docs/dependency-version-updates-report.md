# Dependency version update report

**Generated:** 2026-04-19  
**Monorepo:** brainstrike (pnpm workspaces + Turborepo)  
**Tooling:** `pnpm@10.33.0` (see root `package.json` `packageManager`)  
**Node engine (declared):** `22.x` (root `package.json` `engines`)  

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
| `@brainstrike/build-utils` | `packages/build-utils` | 0.1.0 | yes |
| `@brainstrike/chunking-worker` | `packages/chunking-worker` | 0.1.0 | yes |
| `@brainstrike/config` | `packages/config` | 0.1.0 | yes |
| `@brainstrike/db` | `packages/db` | 0.1.0 | yes |
| `@brainstrike/db-explorer` | `packages/db-explorer` | 0.1.0 | yes |
| `@brainstrike/desktop` | `apps/desktop` | 0.1.0 | yes |
| `@brainstrike/docs` | `apps/docs` | 0.1.0 | yes |
| `@brainstrike/embedding-worker` | `packages/embedding-worker` | 0.1.0 | yes |
| `@brainstrike/embeddings` | `packages/embeddings` | 0.1.0 | no |
| `@brainstrike/file-explorer` | `packages/file-explorer` | 0.1.0 | yes |
| `@brainstrike/file-explorer-hooks` | `packages/file-explorer-hooks` | 0.1.0 | yes |
| `@brainstrike/file-explorer-ui` | `packages/file-explorer-ui` | 0.1.0 | yes |
| `@brainstrike/file-import` | `packages/file-import` | 0.1.0 | yes |
| `@brainstrike/file-system` | `packages/file-system` | 0.1.0 | no |
| `@brainstrike/file-tree-worker` | `packages/file-tree-worker` | 0.1.0 | yes |
| `@brainstrike/hooks` | `packages/hooks` | 0.1.0 | yes |
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
| Distinct direct dependencies checked (`pnpm outdated -r`) | 46 |
| Outdated (current ≠ latest) or deprecated | 46 |
| Up to date (current === latest, not deprecated) | 0 |

## Outdated or deprecated packages

| Package | Current | Wanted | Latest | Bump | Type | Deprecated | Dependents |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@assistant-ui/styles` | 0.3.7 | 0.3.7 | 0.3.7 | — | devDependencies | yes | @brainstrike/desktop, @brainstrike/web |
| `@biomejs/biome` | 2.4.4 | 2.4.4 | 2.4.12 | patch | devDependencies | no | @brainstrike/web, brainstrike |
| `@codecov/vite-plugin` | 1.9.1 | 1.9.1 | 2.0.1 | major | devDependencies | no | @brainstrike/web |
| `@commitlint/cli` | 20.4.2 | 20.4.2 | 20.5.0 | minor | devDependencies | no | brainstrike |
| `@commitlint/config-conventional` | 20.4.2 | 20.4.2 | 20.5.0 | minor | devDependencies | no | brainstrike |
| `@commitlint/types` | 20.4.0 | 20.4.0 | 20.5.0 | minor | devDependencies | no | brainstrike |
| `@docusaurus/core` | 3.9.2 | 3.9.2 | 3.10.0 | minor | dependencies | no | @brainstrike/docs |
| `@docusaurus/module-type-aliases` | 3.9.2 | 3.9.2 | 3.10.0 | minor | devDependencies | no | @brainstrike/docs |
| `@docusaurus/preset-classic` | 3.9.2 | 3.9.2 | 3.10.0 | minor | dependencies | no | @brainstrike/docs |
| `@docusaurus/theme-mermaid` | 3.9.2 | 3.9.2 | 3.10.0 | minor | dependencies | no | @brainstrike/docs |
| `@docusaurus/tsconfig` | 3.9.2 | 3.9.2 | 3.10.0 | minor | devDependencies | no | @brainstrike/docs |
| `@docusaurus/types` | 3.9.2 | 3.9.2 | 3.10.0 | minor | devDependencies | no | @brainstrike/docs |
| `@electric-sql/pglite` | 0.3.15 | 0.3.15 | 0.4.4 | minor | devDependencies | no | @brainstrike/embeddings, @brainstrike/file-import |
| `@huggingface/transformers` | 4.0.1 | 4.0.1 | 4.1.0 | minor | dependencies | no | @brainstrike/agent, @brainstrike/embedding-worker, @brainstrike/embeddings |
| `@mastra/core` | 1.8.0 | 1.8.0 | 1.25.0 | minor | dependencies | no | @brainstrike/agent |
| `@mastra/mcp` | 1.0.2 | 1.0.2 | 1.5.0 | minor | dependencies | no | @brainstrike/agent |
| `@modelcontextprotocol/sdk` | 1.26.0 | 1.26.0 | 1.29.0 | minor | dependencies | no | @brainstrike/desktop |
| `@playwright/test` | 1.58.2 | 1.58.2 | 1.59.1 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/test-utils, @brainstrike/web, brainstrike |
| `@shikijs/langs` | 3.23.0 | 3.23.0 | 4.0.2 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@shikijs/themes` | 3.23.0 | 3.23.0 | 4.0.2 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@stryker-mutator/api` | 9.5.1 | 9.5.1 | 9.6.1 | minor | devDependencies | no | @brainstrike/db, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/hooks, @brainstrike/test-utils, @brainstrike/workers |
| `@stryker-mutator/core` | 9.5.1 | 9.5.1 | 9.6.1 | minor | devDependencies | no | @brainstrike/db, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-system, @brainstrike/hooks, @brainstrike/selection-rules, @brainstrike/test-utils, @brainstrike/utils, @brainstrike/workers |
| `@stryker-mutator/typescript-checker` | 9.5.1 | 9.5.1 | 9.6.1 | minor | devDependencies | no | @brainstrike/db, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-system, @brainstrike/hooks, @brainstrike/selection-rules, @brainstrike/test-utils, @brainstrike/utils, @brainstrike/workers |
| `@stryker-mutator/vitest-runner` | 9.5.1 | 9.5.1 | 9.6.1 | minor | devDependencies | no | @brainstrike/db, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-system, @brainstrike/hooks, @brainstrike/selection-rules, @brainstrike/test-utils, @brainstrike/utils, @brainstrike/workers |
| `@types/node` | 25.3.1 | 25.3.1 | 25.6.0 | minor | devDependencies | no | @brainstrike/agent, @brainstrike/app-shell, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/docs, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-explorer-ui, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/platform-utils, @brainstrike/preferences, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/server-config, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/vector-management, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `@typescript-eslint/parser` | 8.56.1 | 8.56.1 | 8.58.2 | minor | devDependencies | no | brainstrike |
| `dompurify` | 3.3.1 | 3.3.1 | 3.4.0 | minor | dependencies | no | @brainstrike/web |
| `electron` | 40.6.1 | 40.6.1 | 41.2.1 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/file-system, @brainstrike/storage |
| `esbuild` | 0.27.4 | 0.27.4 | 0.28.0 | minor | devDependencies | no | @brainstrike/db |
| `eslint` | 10.0.2 | 10.0.2 | 10.2.1 | minor | devDependencies | no | brainstrike |
| `eslint-plugin-react-hooks` | 7.0.1 | 7.0.1 | 7.1.1 | minor | devDependencies | no | brainstrike |
| `happy-dom` | 20.7.0 | 20.7.0 | 20.9.0 | minor | devDependencies | no | @brainstrike/file-system, @brainstrike/hooks, @brainstrike/platform-utils, @brainstrike/vector-management, brainstrike |
| `jsdom` | 28.1.0 | 28.1.0 | 29.0.2 | major | devDependencies | no | @brainstrike/app-shell, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/file-explorer-ui, @brainstrike/file-import, @brainstrike/preferences, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/ui, @brainstrike/vector-management, @brainstrike/web |
| `knip` | 5.85.0 | 5.85.0 | 6.4.1 | major | devDependencies | no | @brainstrike/web, brainstrike |
| `lucide-react` | 0.575.0 | 0.575.0 | 1.8.0 | major | devDependencies | no | @brainstrike/file-explorer-ui |
| `mermaid` | 11.12.3 | 11.12.3 | 11.14.0 | minor | devDependencies | no | brainstrike |
| `playwright` | 1.58.2 | 1.58.2 | 1.59.1 | minor | devDependencies | no | @brainstrike/config, @brainstrike/db, @brainstrike/storage, @brainstrike/web, brainstrike |
| `react-helmet-async` | 2.0.5 | 2.0.5 | 3.0.0 | major | devDependencies | no | @brainstrike/desktop |
| `react-resizable-panels` | 4.6.5 | 4.6.5 | 4.10.0 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `react-router-dom` | 7.13.1 | 7.13.1 | 7.14.1 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/ui |
| `shiki` | 3.23.0 | 3.23.0 | 4.0.2 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `syncpack` | 14.0.0 | 14.0.0 | 14.3.0 | minor | devDependencies | no | brainstrike |
| `turbo` | 2.8.17 | 2.8.17 | 2.9.6 | minor | devDependencies | no | brainstrike |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | major | devDependencies | no | @brainstrike/agent, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/config, @brainstrike/db, @brainstrike/desktop, @brainstrike/docs, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/pipeline, @brainstrike/platform-utils, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `ultracite` | 7.2.3 | 7.2.3 | 7.6.0 | minor | devDependencies | no | brainstrike |
| `vercel` | 50.23.2 | 50.23.2 | 51.7.0 | major | devDependencies | no | brainstrike |

## Up to date (not listed above)

These packages had **current === latest** and were **not** marked deprecated:



## Related

- [`dependency-updates-breaking-changes.md`](./dependency-updates-breaking-changes.md) — migration notes and changelog pointers for high-risk upgrades.
