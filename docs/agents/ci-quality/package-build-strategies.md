# Package build strategies — evidence

Supports `docs/agents/ci-quality.md` § "Canonical package build strategies" and
§ "Agent declaration build split" (BST-1014). Read this before proposing a new
bundled package, a tsup replacement, a dual-format library export, a change to
NodeNext/Bundler resolution for a library, or a change to the agent watcher
topology. The contract holds the rules; this file is the record of why.

Corrected since first written: the pruned tsc-only library count was "30" when
this was recorded; the workspace has 38 today (39 tsc-only libraries including
the `workers` exception). The guard floors (`MIN_PRUNED_TSC_LIBRARY_PACKAGES`,
`MIN_TSC_LIBRARY_PACKAGES`) are minimums, not the census.

### Canonical package build strategies (BST-1014)

Non-native typed packages have two JavaScript build classes, derived from
`scripts.build` rather than from a package registry:

- **Libraries use TypeScript emit.** A plain library builds JavaScript and
  declarations together with `tsc -b`. All 38 libraries with the canonical
  `rootDir: src` / `outDir: dist` layout prepend
  `node ../../scripts/prune-stale-dist.mjs`; it removes deleted-source artifacts
  without discarding `.tsbuildinfo`, so a normal build does not turn
  TypeScript's project-reference builder into a forced clean rebuild. The sole
  tsc-only layout exception is `workers`: its source files live at the package
  root, outside the pruner's deliberately narrow safety contract, so it keeps an
  explicit clean. This is derived from resolved compiler layout, not a package
  allowlist. A TypeScript-emitted library does not retain a tsup config, tsup
  dependency, or tsup watch command.
- **tsup is for real bundle boundaries.** Eight packages require bundling:
  `chunking-worker`, `embedding-worker`, `file-tree-worker`, and `token-cache`
  package browser workers/WASM/assets; `agent` produces the self-contained
  hosted-web boundary; `assistant-service` and `assistant-wire` retain the CJS
  surface retained for CommonJS consumers; and `file-explorer` emits the
  renderer's worker-storage artifact. Adding a ninth bundler is an architectural
  decision, not a convenient way to emit a second module format.
  This is the compatibility boundary for BST-1014, not an endorsement of tsup as
  the R10 endpoint: upstream marks tsup unmaintained and recommends tsdown. A
  replacement must preserve the custom worker/WASM/assets and CJS contracts and
  carry measured artifact and wall-clock evidence; swapping emitters inside the
  library migration would combine those risks and make regressions unattributable.
- **Native addons remain native builds.** `secure-fs-native` and
  `windows-job-native` use `node-gyp`; the build-strategy guard recognizes that
  structural class rather than pretending a TypeScript or tsup command owns the
  native artifact.
- **Node-compatible emitted ESM is compiler-enforced.** Libraries migrated from
  tsup extend `packages/config/tsconfig/node-library.json`, whose `module` and
  `moduleResolution` are `NodeNext`; declare `type: module`; expose the one emitted
  runtime artifact through `types` + `default`; and spell local TypeScript imports
  as `.js` in source. TypeScript therefore rejects extensionless relative imports,
  directory imports, invalid package-export subpaths, and missing JSON attributes
  during every editor/type-check/build pass. A `require` export condition is not a
  synonym for “Node can require synchronous ESM”: it must point to a real CJS
  artifact. A CommonJS composition boundary that consumes one of these libraries
  uses native dynamic `import()` (and an explicit `resolution-mode: import` for
  type-only imports) rather than forcing the library back into dual-format
  bundling. The Vercel API now declares native ESM in the web manifest; its Node16
  check enforces explicit relative `.js` imports. Vercel disables `require(ESM)`
  by default, so hosted functions must select the agent's ESM export, including
  native imports of external Mastra/provider runtimes. The existing hosted bundle
  guard loads ESM under the Node 26 toolchain with
  `--no-experimental-require-module`, kills a nonterminating probe after 30 seconds,
  and permits no ESM-only
  workspace `require()` exceptions. Pino and tiktoken remain external runtime
  dependencies declared by the bundle owner; inlining their Node/WASM loaders
  would break native loading or browser asset references. Validate both built
  preview status and POST rejection through the generated function artifacts,
  then the deployed preview; a successful Vercel build is not runtime proof.
  Playwright's
  TypeScript loader is a distinct CommonJS
  transform boundary: a Node-side E2E helper imports the narrowest side-effect-
  free contract subpath it needs instead of a package barrel that transitively
  loads browser-oriented `import.meta` modules. Desktop assistant mocks pin this
  through `@brainstrike/assistant-contract/assistant-stream-session`; the desktop
  smoke lane is the runtime proof.
- **Browser-only emit keeps Bundler resolution.** `file-explorer-hooks` is a
  React/Vite library whose public surface imports the browser-only `ui` barrel.
  That barrel's declarations intentionally model a bundler and contain
  extensionless re-exports; consuming them under NodeNext loses named exports
  behind `skipLibCheck` (TS2305 at the hook tests). The package therefore extends
  the shared Bundler config while still using the same canonical `tsc -b` build.
  Module resolution follows the runtime that loads the emitted graph; it is not
  a second build strategy.

`scripts/verify-package-build-strategies.mjs` (alias
`lint:package-build-strategies`, present in both lint chains) enforces the two
classes, the native-addon exception, the exact bundler budget, incremental-safe
cleanup for every compatible src-to-dist library, removal of every supported tsup config-file
shape/dependency/dev command, canonical `tsup.config.ts` for current bundles,
NodeNext manifest conditions, and that every dist code export is an output of
the package's parsed TypeScript program. TypeScript's config loader resolves
array and indirect `extends`; the guard does not approximate inheritance or
re-parse module syntax. Discovery comes from workspace manifests and resolved
compiler configs; there is no identity mapping file. Its anti-vacuity floors
cover typed build packages, tsc-only libraries, incremental-safe pruned
libraries, and NodeNext consumers. The
paired `scripts/__tests__/verify-package-build-strategies.test.mjs` money tests
mutate each protected seam, while a real compiler control observes NodeNext
rejecting an extensionless ESM import with TS2835.

### Agent declaration build split

`@brainstrike/agent` declarations are emitted by the package's composite
TypeScript project before tsup bundles JavaScript. Every agent tsup config
inherits `dts: false`; do not restore tsup's declaration-bundler worker or its
separate compiler-options override. The canonical `tsconfig.json` owns the
assistant-contract path mapping and emits every public entry declaration plus
the internal declaration graph those entries reference.

Development runs a project-only TypeScript watcher and the tsup watcher as
named sibling processes through the package's direct `concurrently`
dependency. The declaration watcher must use `tsc --project`, not
`tsc --build`: referenced packages own separate Turbo watchers, so build mode
would create multiple processes that can concurrently emit into the same
dependency `dist` directories. The watcher supervisor must terminate the
sibling when either process exits, so a failed declaration watcher cannot
leave a stale-but-running JavaScript watcher. The build order, disabled tsup
DTS worker, project-only declaration watch, and two-watcher topology are
guarded by `scripts/__tests__/agent-declaration-build-contract.test.mjs`.
