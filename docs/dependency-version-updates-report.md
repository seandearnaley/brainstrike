# Dependency version update report

**Generated:** 2026-04-20  
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
| Distinct direct dependencies checked (`pnpm outdated -r`) | 7 |
| Outdated (current ≠ latest) or deprecated | 7 |
| Up to date (current === latest, not deprecated) | 0 |

## Outdated or deprecated packages

| Package | Current | Wanted | Latest | Bump | Type | Deprecated | Dependents |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@assistant-ui/styles` | 0.3.7 | 0.3.7 | 0.3.7 | — | devDependencies | yes | @brainstrike/desktop, @brainstrike/web |
| `@codecov/vite-plugin` | 1.9.1 | 1.9.1 | 2.0.1 | major | devDependencies | no | @brainstrike/web |
| `@electric-sql/pglite` | 0.3.16 | 0.3.16 | 0.4.4 | minor | devDependencies | no | @brainstrike/embeddings, @brainstrike/file-import |
| `knip` | 5.88.1 | 5.88.1 | 6.4.1 | major | devDependencies | no | brainstrike |
| `react-helmet-async` | 2.0.5 | 2.0.5 | 3.0.0 | major | devDependencies | no | @brainstrike/desktop |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | major | devDependencies | no | @brainstrike/agent, @brainstrike/build-utils, @brainstrike/chunking-worker, @brainstrike/config, @brainstrike/db, @brainstrike/desktop, @brainstrike/docs, @brainstrike/embedding-worker, @brainstrike/embeddings, @brainstrike/file-explorer, @brainstrike/file-explorer-hooks, @brainstrike/file-import, @brainstrike/file-system, @brainstrike/file-tree-worker, @brainstrike/hooks, @brainstrike/pipeline, @brainstrike/platform-utils, @brainstrike/queue, @brainstrike/queue-telemetry-collector, @brainstrike/selection-rules, @brainstrike/storage, @brainstrike/test-utils, @brainstrike/text-splitter, @brainstrike/token-cache, @brainstrike/types, @brainstrike/ui, @brainstrike/utils, @brainstrike/web, @brainstrike/worker-runtime, @brainstrike/workers, brainstrike |
| `vercel` | 50.44.0 | 50.44.0 | 51.7.0 | major | devDependencies | no | brainstrike |

## Up to date (not listed above)

These packages had **current === latest** and were **not** marked deprecated:



## Related

- [`dependency-updates-breaking-changes.md`](./dependency-updates-breaking-changes.md) — migration notes and changelog pointers for high-risk upgrades.
