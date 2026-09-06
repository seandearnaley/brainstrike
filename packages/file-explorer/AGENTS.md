# `@brainstrike/file-explorer` — AGENTS.md

> **Purpose**
> Core state, actions, caching, and persistence for the **Brainstrike file explorer**. This package is **UI-agnostic** (no React/Electron/UI code). It is consumed by apps and UI packages (e.g. `@brainstrike/file-explorer-ui`). Changes here must preserve determinism, serializability, and main-thread performance.

* Languages/Tooling: TypeScript, the repository's Node 24.x runtime (this
  package declares compatibility with Node >=22), Zustand v5, Vitest, Stryker,
  and tsup (ESM+CJS).
* Boundaries: Import only from declared workspace dependencies and listed peers. No React, no DOM, no Electron.

---

## Quickstart (package scope)

### Install, build, test

```bash
# from repo root
pnpm install
pnpm --filter @brainstrike/file-explorer build
pnpm --filter @brainstrike/file-explorer test
pnpm --filter @brainstrike/file-explorer run mutation   # Stryker mutation tests
```

Use **Turbo filters** to avoid repo-wide work; `turbo run` supports package selectors via `--filter`. ([Turborepo][1])

### What this package exports

* **Store & factory**
  `useFileExplorerStore` (bound store) and `createFileExplorerStore(adapter)` for isolated instances/tests.
* **Action groups (tree-shakable)**
  `actions/*` modules are re-exported for focused imports when needed.
* **Feature utilities (narrow subpaths)**
  `@brainstrike/file-explorer/selection` owns composite selection keys;
  `/file-tree` owns file-explorer tree queries; `/project-tree-text` owns
  filtered tree rendering; `/context-generation` owns LLM context projection.
  These surfaces are feature contracts, not general-purpose utilities, and
  must not move back into `@brainstrike/utils`. Context traversal accepts the
  platform-neutral `FileSystemAdapter` plus `DirectoryHandle`; browser DOM
  handles stay inside file-system adapters and consumer packages.

---

## Architecture & invariants

### State model (top-level)

* `currentFolderId: string | null`
* `selectedFilePaths: Set<string>` — **composite keys** `"<folderId>|@|<path>"`. Use `encodeFileSelection()`; never store raw paths.
* `expandedDirectoryPaths: Set<string>` — expanded dirs; collapsing a parent removes all descendants.
* `folderStates: Record<string, FolderState>` — per-folder snapshot (filters, tabs, selections, expansions, limits).
* `fileContents: Record<string, string>` — **volatile** view over cache (filtered under pressure; see below).
* Filters & settings: `includeFilters: string[]`, `excludeFilters: string[]`, `useRegex: boolean`,
  `includeProjectTree: boolean`, `folderSummaryThreshold: number` (clamped),
  `maxSelectionCount: number` (clamped & may trim selection), `lastActiveTab: string`, `quickFilter: string`.

> **Invariants**
>
> * Composite keys are mandatory in `selectedFilePaths`.
> * All sets/records are serializable via our serializer; we convert Sets ⇄ Arrays at the persistence boundary.
> * No functions/instances in persisted data; only plain data. Use `partialize/merge/migrate` in our persist config. ([Zustand Documentation][2])

### Actions (public contract)

* **Folder context**

  * `setCurrentFolderId(folderId | null)` — saves current folder state; updates LRU order; prunes > `MAX_FOLDER_STATES`; hydrates or creates target folder state.
  * `hydrateFolderState(folderId)` — reapplies a saved folder’s values to top-level fields.
* **Selections**

  * `addSelectedFile(folderId, path)` / `removeSelectedFile` / `toggleSelectedFile`
  * `setSelectedFiles(Set<string>)` validates every composite key before replacement.
  * `addMultipleSelectedFiles(folderId, paths[])` / `removeMultipleSelectedFiles(folderId, paths[])`
    Selection-adding actions enforce `maxSelectionCount`; reducing the limit
    trims the current selection.
  * `reconcileSelectionWithDirectorySnapshot(s)` consumes complete, root-scoped
    directory listings after refresh; it removes only selections disproven by
    those listings and preserves query mode through exclusion overrides. When
    a query manifest is unavailable, only the exact cached materialized
    projection may be reconciled; never infer missing manifest membership.
    Selection is files-only: an authoritative same-path directory proves a
    selected file was retyped and removes it.
  * `getSelectionAncestorDirectories(state, folderId, rootPath)` derives the
    unique parent-first directory boundaries needed after a shallow root
    refresh by walking selected paths and ancestors only, never the file tree.
    It preserves each selected path's exact slash/backslash presentation so
    the result remains an exact normalized-tree key; normalization is only for
    containment, case comparison, dedupe, and ordering. It is a pure derivation
    and enforces no selection cap.
  * `getSelectionProjectionPaths(state, folderId)` is the canonical effective
    projection reader: focused query roots resolve manifest/overrides, while
    foreign roots read their explicit folder snapshot. Refresh fencing must
    reuse it rather than infer projection changes from `selectionVersion`.
  * Encode/decode composite keys through `@brainstrike/file-explorer/selection`.
    Malformed keys throw; callers must not guess or silently coerce them.
    `getSelectedPathsForFolder` is the canonical folder-scoped strict decoder
    used by reconciliation and accepts read-only selection sets.
* **Directory expansion**

  * `toggleDirectoryExpansion(path)` (collapsing a parent removes its descendants)
  * `setExpandedPaths(Set<string>)`, `expandAllDirectories(fileTree)`, `collapseAllDirectories()`.
* **Settings**

  * `setFilters(include[], exclude[])`, `setUseRegex(bool)`, `setIncludeProjectTree(bool)`
  * `setFolderSummaryThreshold(n)` (clamped), `setMaxSelectionCount(n)` (clamped + **trims** selection)
  * `setLastActiveTab(string)`
* **File content cache**

  * `setFileContent(compositeKey, content)` / `getFileContent(compositeKey)`
  * `clearFileContents(keys[])`, `clearAllFileContents()`
  * `getFileContentCacheStats()`, `evictOldFileContents(count?)`

---

## File content cache (LRU) & memory pressure

* In-memory LRU with **\~5 MB cap / 50 entries**; files **>1 MB are skipped** (warned).
* The LRU is owned by ONE Zustand store instance and is created when that
  store's `StateCreator` runs. It is never module-global: a retired provider's
  in-flight read may finish against its retired store/cache, but it cannot
  repopulate content returned by a replacement store. `clearFileContents`,
  `clearAllFileContents`, eviction, and cache stats operate only on that same
  store-owned cache. Renderer factory reset explicitly calls
  `clearAllFileContents()` on the live provider store because web reset need
  not reload the page; clearing persisted browser storage alone is not enough.
* When cache usage exceeds \~**2 MB** we **filter `fileContents` in state** to: current file + \~10 most recent, while **all content remains in the cache**. Always fetch via `getFileContent()` to avoid reading a filtered-out entry from state.
* Motivation: avoid multi-MB JSON snapshots on persistence and keep re-renders/lightweight state.

---

## Persistence (Zustand `persist`) & migrations

* Storage key: **`file-explorer-storage-v4`**. Legacy key **`fileExplorerSettings`** is auto-migrated on startup only when no current-key snapshot exists.
* We persist only a **partialized** slice (no functions, no cache) and **merge** back into current defaults on hydration. Schema changes use `version` + `migrate`; because this app is still greenfield, older file-explorer snapshots are discarded rather than migrated when their semantics are no longer trusted. See Zustand docs for `persist` options (`partialize`, `merge`, `version`, `migrate`). ([Zustand Documentation][2])
* Invalid JSON, corrupt same-version shapes, and unsupported versions recover to
  the empty serialized state and set the ephemeral
  `persistenceRecoveryNotice`. Missing first-run state and valid hydration do
  not set it. Consumers atomically drain the notice through
  `consumePersistenceRecoveryNotice()` so one discarded payload can produce at
  most one notification; the notice itself is never persisted.
* Persistence diagnostics are summaries only (counts, booleans, and schema
  versions). Never log persisted identifiers, root-map keys, paths, raw
  payloads, or JSON parser errors because parser messages can echo payload
  fragments.
* **Never persist large content** (leave it in the LRU). Web Storage is synchronous; large writes/reads can degrade responsiveness—offload to a Worker (below) and keep the payloads small. ([MDN Web Docs][3])

---

## Worker-assisted storage (main-thread safety)

**Why**: `localStorage` API is synchronous and operations occur on the main thread; heavy (de)serialization can hurt interactivity. We offload persistence to a **Web Worker** in browsers and fall back to direct adapter calls in SSR/Electron/headless/tests. MDN: Workers run scripts in **background threads** and communicate via `postMessage`. ([MDN Web Docs][4])

**How we import the worker (bundler-safe)**

```ts
// Always use the bundler-friendly constructor + import.meta.url pattern:
const worker = new Worker(new URL('./worker-storage.worker.js', import.meta.url), { type: 'module' })
```

This pattern makes the URL **relative to the module**, allowing bundlers (Vite/rollup) to emit the worker as a separate chunk reliably. MDN and Vite recommend this form. ([MDN Web Docs][5])

> Notes
>
> * In dev/prod, Vite transforms `new URL(..., import.meta.url)` to the right path and emits the worker asset; we also map `*.worker.js` in `tsup` so the file is copied for runtime loading. ([vitejs][6])
> * The adapter auto-disables the Worker in SSR/tests/Electron/headless and falls back to immediate storage.

### Write ordering (`opId`) — protocol contract

`StorageRequest.opId` sequences `setItem` requests so a late-arriving stale
write cannot clobber a newer one. It is **optional**, and the rules are:

* **`undefined` is the only "unsequenced" signal.** `0` is a legal sequence
  number, not an absence. A truthiness test (`if (opId)`) conflates the two and
  fails the guard OPEN for `opId: 0` — the stale write wins. This was BST-459.
* **`Number.isFinite(opId)` is the predicate**, not `opId !== undefined`. The
  request crosses `postMessage` and is not type-checked at runtime, so the
  declared `opId?: number` does not exclude `NaN` (recorded as the baseline it
  makes every later `opId < NaN` false, disabling the guard for that key) or
  `''` (compares as `0`, so a write that should land is dropped as stale).
  Anything non-finite is treated as unsequenced and simply proceeds.
* **Equal `opId`s proceed.** The comparison is strictly `<`, deliberately: the
  in-repo producer emits `Date.now()`, so two saves in the same millisecond
  share an id and both must land.
* The producer is `worker-storage.worker.mjs`. If it ever moves off
  `Date.now()` to a monotonic counter, that counter starts at `0` — which is
  exactly the case the first rule protects.

---

## React / subscription guidance (for consumers)

Zustand v5 removed equalityFns on `create`; use **`createWithEqualityFn`** (and/or `useStoreWithEqualityFn`) to control re-renders in consumer apps. Subscribe with selectors; avoid grabbing entire state in UI. ([Zustand Documentation][7])

---

## Usage examples

### Basic usage

```ts
import { useFileExplorerStore } from '@brainstrike/file-explorer';

const { expandedDirectoryPaths, toggleDirectoryExpansion } = useFileExplorerStore();
toggleDirectoryExpansion('src/components');
```

### Isolated store (tests or multiple explorers)

```ts
import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { createFileExplorerStore } from '@brainstrike/file-explorer';

const adapter = createMemoryStorageAdapter();
const store = createFileExplorerStore(adapter);

store.getState().setCurrentFolderId('my-folder');
store.getState().addSelectedFile('my-folder', 'src/index.ts');
```

### Selecting many files safely

```ts
store.getState().addMultipleSelectedFiles('repo-root', [
  'src/a.ts', 'src/b.ts', 'src/c.ts'
]);
// Respects maxSelectionCount and de-duplicates composite keys.
```

### Reading file content under pressure

```ts
// Always prefer getFileContent(), since state may be filtered under cache pressure:
const content = store.getState().getFileContent('repo-root|@|src/a.ts');
```

---

## Performance & guardrails

* **Selection limits**: `maxSelectionCount` is enforced by all selection actions and **trims** when reduced.
* **Expand/collapse**: Collapsing a parent removes descendants from `expandedDirectoryPaths`.
* **Cache pressure**: Over \~2 MB, the store filters `fileContents` for memory safety; use `getFileContent()`.
* **No side effects** in action creators (no I/O, no DOM). I/O happens outside; results flow in via actions.
* **Persist minimal state**: Only serializable, essential fields—use `partialize`/`merge` rather than ad-hoc storage. ([Zustand Documentation][2])
* **Context generation fails closed**: invalid filters and adapter traversal
  failures throw contextual errors. Never widen a malformed filter or emit a
  partial project tree as if context generation succeeded. Synchronous React
  previews use the typed `generateProjectTreeTextResult` surface to render
  known pattern errors visibly; async exports keep the strict throwing surface.

---

## Testing

* **Unit & integration**: Vitest in `node` environment; colocated under `src/**/__tests__` or `*.test.ts(x)`.
* **Mutation**: Stryker with the **Vitest Runner**; thresholds configured in `stryker.config.js`. Keep the score high; fix tests when mutants survive. ([Stryker Mutator][8])
* Tips:

  * Use `zustand/vanilla` to integrate actions without React.
  * Prefer fake timers and microtask flush to avoid flakiness during worker/persist tests.

---

## Troubleshooting

* **Hydration mismatches**: Ensure your field is included in `serializeState` and reconstructed in `mergeState` (Sets ⇄ Arrays). See Zustand persist docs for `migrate`/`merge`. ([Zustand Documentation][2])
* **Worker not found / 404**: Use `new URL('./worker.js', import.meta.url)` so the bundler emits a separate worker asset; avoid dynamic/non-analyzable paths. ([Vite][9])
* **UI jank during saves**: Keep payloads small (don’t persist `fileContents`), and ensure the Worker path is correct. Web Storage is synchronous; big JSON writes can block. ([MDN Web Docs][3])

---

## Monorepo etiquette (apply within this package)

* Prefer **filtered** Turbo runs: `pnpm --filter @brainstrike/file-explorer <cmd>`. ([Turborepo][1])
* Don’t alter shared root configs (`tsconfig.*`, `turbo.json`, etc.) unless explicitly requested.
* Don’t start app servers from this package (no dev server here).
* Keep the worker bundling intact (see tsup config & note above).

---

## Extending the store (checklist)

1. **Types first**: update `@brainstrike/types` (`FileExplorerState`, `FolderState`, and if persisted, `SerializedState`).
2. **Defaults**: add to `DEFAULT_STATE`.
3. **Persistence**: wire up in `serializeState`/`mergeState` and bump `version` + `migrate` if schemas change. ([Zustand Documentation][2])
4. **Actions**: implement in the appropriate `create*Actions` module; keep pure and deterministic.
5. **Tests**: add Vitest (edge cases + round-trip persist) and keep Stryker score healthy. ([Stryker Mutator][8])
6. **Docs**: update this file—especially invariants, limits, and persistence/migration notes.

---

## References

* **Zustand v5 & equality functions**: `createWithEqualityFn`, v5 migration notes. ([Zustand Documentation][10])
* **Zustand `persist`**: versioning, `partialize`, `merge`, `migrate`. ([Zustand Documentation][2])
* **Web Workers**: background threads & `postMessage`. ([MDN Web Docs][4])
* **Worker import pattern**: `new Worker(new URL('./worker.js', import.meta.url))` in Vite & MDN Worker docs. ([Vite][9])
* **Web Storage**: synchronous operations can impact responsiveness; keep payloads small. ([MDN Web Docs][3])
* **Stryker Vitest runner**: plugin docs. ([Stryker Mutator][8])
* **Turbo tasks & filters**: docs & run reference. ([Turborepo][1])

---

**This doc is package-scoped.** The monorepo root has its own AGENTS.md for global policy. Treat this as **living documentation**: update it when actions, serializer rules, keys/versions, or worker behavior change.

[1]: https://turborepo.com/docs/crafting-your-repository/running-tasks "Running tasks"
[2]: https://zustand.docs.pmnd.rs/integrations/persisting-store-data "Persisting store data - Zustand"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API "Web Storage API - MDN - Mozilla"
[4]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers "Using Web Workers - Web APIs - MDN"
[5]: https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker "Worker() constructor - Web APIs - MDN"
[6]: https://vite.dev/guide/assets "Static Asset Handling"
[7]: https://zustand.docs.pmnd.rs/migrations/migrating-to-v5 "How to Migrate to v5 from v4 - Zustand"
[8]: https://stryker-mutator.io/docs/stryker-js/vitest-runner/ "Vitest Runner"
[9]: https://v3.vitejs.dev/guide/features "Features"
[10]: https://zustand.docs.pmnd.rs/apis/create-with-equality-fn "createWithEqualityFn ⚛️ - Zustand"
