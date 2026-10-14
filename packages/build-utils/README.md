# @brainstrike/build-utils

Node-side build helpers and Vite plugins shared by app configurations. Import
these from build/config code, not renderer runtime code.

## Qualified assets and module graphs

`resolveTransformersOnnxRuntimeWasmFiles` resolves the installed Transformers/ONNX
Runtime assets from explicit consumer package directories.
`transformersOnnxRuntimeWasmUrlsPlugin` publishes the existing virtual module used
by `@brainstrike/embedding-worker/vite`, emitting the actual module/binary assets
for both dev and production serving. Missing or ambiguous assets refuse rather
than selecting an arbitrary version or CDN.

`findPGliteWasm(baseDir)` is a separate resolver for remaining PGlite consumers;
it returns a path or `null`. Its presence does not imply desktop runs PGlite.
Handle absence at the owning build boundary.

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

Use the package's existing scripts, including integration checks for emitted
build boundaries when relevant. Local consumers use `workspace:*`.
Select checks with
[validation guidance](../../docs/agents/ci-quality.md).
