# BST-1761: initial Knip inventory

Owner: Sean Dearnaley (`@seandearnaley`). Baseline: `093b8db6a` (latest
`origin/main` when this branch was created). Work recorded September 19 UTC
(September 18 in America/New_York). This is one PR based directly on
main. Required checks from the live ruleset: Static, Unit, Build, Web E2E,
Desktop E2E. No earlier implementation PR was found; BST-1759 corrected only
the documentation. Linear status, assignee and relations remain unchanged.

Acceptance: restore a visible scheduled/manual audit, prove file/dependency
liveness, preserve special entrypoints and compatibility exports, disposition
the initial inventory, and remove a bounded confirmed-unused batch.

## Inventory and dispositions

`pnpm knip` (Knip 6.34.0, frozen lockfile) initially exited 1 with **seven
dependency findings, no unused-file findings**, and 151 configuration hints.
These are findings, not a dead-code percentage.

| Finding | Disposition and evidence |
| --- | --- |
| `@brainstrike/platform-utils` in `packages/db-explorer` | Delete declaration. No source, test, config or dynamic-load references; the README's platform-detection dependency claim is stale and removed with it. |
| `@brainstrike/platform-utils` in `packages/file-explorer-ui` | Delete declaration. No source, test, config or dynamic-load references. Dependencies that import platform-utils keep their own declarations. |
| `@testing-library/jest-dom` in `apps/web`, `packages/assistant-data`, `packages/notes-vault`, `packages/workspace-search` | Delete these four declarations. All four Vitest configs load `@brainstrike/test-utils/vitest.setup`; that package imports and declares jest-dom. Their test tsconfigs use test-utils' matcher types. No direct jest-dom references remain in these four workspaces. Direct consumers elsewhere retain their declarations. |
| Root `oxc-transform-react` | Retain. `scripts/react-compiler-inventory.mjs` directly imports `transformSync`; scripts are deliberately outside Knip's root graph. Add a root-workspace-only dependency exception with that concrete consumer. App compiler declarations also remain. |
| 151 configuration hints | Retain for this bounded change. Hints are not unused dependency/file findings: several merely mark redundant patterns, while CSS scope, dynamic loads, script entries and library exports need their existing exceptions. No blanket auto-fix or widened ignore is applied. |

## Repository factory investigation

`createFileRecordRepository` and `isPGlite` have no production call sites in
tracked source. They are nevertheless exported by
`packages/db/src/repositories/index.ts` through the package's public root
barrel. `repository-factory.test.ts`, `bulk-import.test.ts` and
`migration-integration.test.ts` exercise them. Knip did **not** report this
module unused: its barrel is reachable and unused exports/types are disabled.

Retain the factory and its tests as an exported compatibility surface in this
batch. Absence of production callers does not alone establish permission to
remove that surface. A deliberate retirement would retarget bulk-import and
migration assertions to `FileRecordRepository`, preserve the Electron adapter's
SQL/record-mapping tests, and remove only tests of the retired factory dispatch.
No behavior coverage is deleted here. The initial cleanup consists of the six
confirmed redundant manifest declarations above.

## Protected reachability

Keep all curated `knip.jsonc` entries and exclusions. The liveness probe asserts
that the desktop watchdog worker, official conformance child entry, file-content
worker, embedding CLI and database queue CLI exist and are not unused-file
findings. These include build/file-name entrypoints, not just imported modules.
CSS imports (fonts, Tailwind plugins and mcp-app-host-ui), Vite prebundles,
indirected native requires, bundled WASM and browser Node stubs retain their
existing documented exceptions. Export/type/duplicate checking stays disabled;
this audit does not claim coverage of those categories.

## Execution and cost

Initial local macOS arm64 command: `/usr/bin/time -p pnpm knip` after a frozen
install in a fresh worktree. Prerequisite builds were uncached: three successful
Turbo tasks, 1.174s. Whole command: **14.62s real**, exit 1. Setup/install time
is excluded; this is not a Linux runner estimate.

The weekly/manual workflow uses the existing setup-workspace composite and
runs `time pnpm knip`, then `node scripts/check-knip-liveness.mjs`. The second
command temporarily plants one unreferenced web source file and restores the
removed db-explorer dependency. It requires exit 1 and exactly those findings,
checks the special entries above, and restores both inputs in `finally`.
Run it serially after `pnpm knip`; it is deliberately outside the default
scripts-test glob so PRs do not acquire a full graph scan indirectly.

Scheduled and manual runs fail visibly on any finding or tool/build error.
Sean owns the failed Actions run's follow-up in BST-1761. Start with Monday
06:37 UTC and dispatch, not another critical-path PR scan. Local scanning is
short, but install/runner costs and sustained false-positive rates remain
unmeasured. The new workflow becomes dispatchable/scheduled after reaching the
default branch; local validation does not prove GitHub runner execution.

After cleanup, the full command completed in **12.27s**, exit 0, with no issue
findings (configuration hints remain). The planted probe completed in **11.36s**:
both the unused file and dependency were reported with exit 1, the five named
special entries were retained, and both fixture inputs were restored.
