# Dependency version update report

**Generated:** 2026-07-07\
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
| `@brainstrike/commands` | `packages/commands` | 0.1.0 | no |
| `@brainstrike/config` | `packages/config` | 0.1.0 | yes |
| `@brainstrike/context-actions` | `packages/context-actions` | 0.1.0 | no |
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
| Distinct direct dependencies checked (`pnpm outdated -r`) | 33 |
| Outdated (current ≠ latest) or deprecated | 33 |
| Up to date (current === latest, not deprecated) | 0 |

## Outdated or deprecated packages

| Package | Current | Wanted | Latest | Bump | Type | Deprecated | Dependents |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@ai-sdk/anthropic` | 3.0.93 | 3.0.93 | 4.0.8 | major | dependencies | no | @brainstrike/agent |
| `@ai-sdk/google` | 3.0.88 | 3.0.88 | 4.0.8 | major | dependencies | no | @brainstrike/agent |
| `@ai-sdk/openai` | 3.0.80 | 3.0.80 | 4.0.8 | major | dependencies | no | @brainstrike/agent |
| `@ai-sdk/provider` | 3.0.10 | 3.0.10 | 4.0.2 | major | dependencies | no | @brainstrike/agent |
| `@assistant-ui/react` | 0.12.25 | 0.12.25 | 0.14.26 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@assistant-ui/react-data-stream` | 0.12.11 | 0.12.11 | 0.12.18 | patch | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@assistant-ui/react-markdown` | 0.12.9 | 0.12.9 | 0.14.5 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@assistant-ui/styles` | 0.3.7 | 0.3.7 | 0.3.7 | — | devDependencies | yes | @brainstrike/desktop, @brainstrike/web |
| `@babel/core` | 7.29.7 | 7.29.7 | 8.0.1 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@babel/parser` | 7.29.7 | 7.29.7 | 8.0.0 | major | dependencies | no | @brainstrike/chunking-worker, @brainstrike/db |
| `@babel/plugin-transform-runtime` | 7.29.7 | 7.29.7 | 8.0.1 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@babel/runtime` | 7.29.7 | 7.29.7 | 8.0.0 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `@codecov/vite-plugin` | 1.9.1 | 1.9.1 | 2.0.1 | major | devDependencies | no | @brainstrike/web |
| `@commitlint/cli` | 20.5.3 | 20.5.3 | 21.2.0 | major | devDependencies | no | brainstrike |
| `@commitlint/config-conventional` | 20.5.3 | 20.5.3 | 21.2.0 | major | devDependencies | no | brainstrike |
| `@commitlint/types` | 20.5.0 | 20.5.0 | 21.2.0 | major | devDependencies | no | brainstrike |
| `@mastra/core` | 1.37.1 | 1.37.1 | 1.49.0 | minor | dependencies | no | @brainstrike/agent |
| `@mastra/mcp` | 1.8.1 | 1.8.1 | 1.13.0 | minor | dependencies | no | @brainstrike/agent |
| `@mastra/memory` | 1.20.0 | 1.20.0 | 1.22.1 | minor | dependencies | no | @brainstrike/agent |
| `@types/node` | 25.9.4 | 25.9.4 | 26.1.0 | major | devDependencies | no | @brainstrike/agent, @brainstrike/app-shell, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/commands, @brainstrike/context-actions, @brainstrike/db, @brainstrike/db-explorer, @brainstrike/desktop, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-explorer-ui, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/platform-utils, @brainstrike/preferences, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/server-config, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/vector-management, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `concurrently` | 9.2.3 | 9.2.3 | 10.0.3 | major | devDependencies | no | @brainstrike/desktop |
| `electron` | 41.10.0 | 41.10.0 | 43.0.0 | major | devDependencies | no | @brainstrike/desktop, @brainstrike/file-system, @brainstrike/storage |
| `knip` | 5.88.1 | 5.88.1 | 6.24.0 | major | devDependencies | no | brainstrike |
| `oxc-parser` | 0.131.0 | 0.131.0 | 0.138.0 | minor | devDependencies | no | @brainstrike/chunking-worker |
| `react-doctor` | 0.5.5 | 0.5.5 | 0.7.1 | minor | devDependencies | no | brainstrike |
| `react-helmet-async` | 2.0.5 | 2.0.5 | 3.0.0 | major | devDependencies | no | @brainstrike/desktop |
| `react-shiki` | 0.9.3 | 0.9.3 | 0.10.1 | minor | devDependencies | no | @brainstrike/desktop, @brainstrike/web |
| `strip-ansi` | 6.0.1 | 6.0.1 | 7.2.0 | major | dependencies | no | @brainstrike/desktop |
| `syncpack` | 14.3.1 | 14.3.1 | 15.3.2 | major | devDependencies | no | brainstrike |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | major | devDependencies | no | @brainstrike/agent, @brainstrike/assistant-contract, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/commands, @brainstrike/config, @brainstrike/context-actions, @brainstrike/db, @brainstrike/desktop, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/indexing-contract, @brainstrike/pipeline, @brainstrike/platform-utils, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `ultracite` | 7.6.0 | 7.6.0 | 7.9.0 | minor | devDependencies | no | brainstrike |
| `vercel` | 50.44.0 | 50.44.0 | 54.20.1 | major | devDependencies | no | brainstrike |
| `web-tree-sitter` | 0.25.10 | 0.25.10 | 0.26.10 | minor | dependencies | no | @brainstrike/chunking-worker |

## Up to date (not listed above)

These packages had **current === latest** and were **not** marked deprecated:



## Related

- [`dependency-updates-breaking-changes.md`](./dependency-updates-breaking-changes.md) — migration notes and changelog pointers for high-risk upgrades.
