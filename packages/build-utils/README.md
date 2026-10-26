# @brainstrike/build-utils

Node-side build helpers and Vite plugins shared by app configurations. Import
these from build/config code, not renderer runtime code.

## Module graphs

`fullReloadOnCompilerHotspots()` invalidates affected modules **and their importer
graph** before suppressing normal HMR and sending a full reload. Preserve that
ordering: a reload with stale transformed imports can split React/context identity.
App dependency-optimization helpers and `preserveWorkerEntryPlugin` retain the
existing entry/asset ownership rather than duplicating worker bootstrap code.

The CSP-qualified warning filter applies only to its declared warning shape; it
does not authorize weakening the runtime CSP or swallowing arbitrary errors.
Build IDs and other exports are defined in [`index.ts`](src/index.ts) and
[`package.json`](package.json).

## Development

There is no build. Vite and Vitest config files import this package, and Vite's
config loader hands it to Node, which strips the types and runs the source
directly. Keep the source erasable TypeScript (`erasableSyntaxOnly`) with `.ts`
relative specifiers.

Use the package's existing scripts, including integration checks for emitted
build boundaries when relevant. Local consumers use `workspace:*`.
Select checks with
`pnpm check`.
