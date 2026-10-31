# @brainstrike/build-utils

Node-side build helpers and Vite plugins for app configs. Import from build/config code only, never from renderer runtime code.

- `fullReloadOnCompilerHotspots()` invalidates affected modules **and their importer graph** before suppressing HMR and sending a full reload. Keep that order: reloading with stale transformed imports splits React/context identity.
- Dependency-optimization helpers and `preserveWorkerEntryPlugin` keep the existing entry/asset ownership; don't duplicate worker bootstrap code.
- `createCspQualifiedEvalWarningFilter()` silences only its declared warning shape. It never authorizes weakening the runtime CSP or swallowing other errors.
- No build step: Vite's config loader hands the source to Node, which strips types. Keep it erasable TypeScript with `.ts` relative specifiers.
