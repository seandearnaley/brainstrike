# `@brainstrike/file-explorer-ui` — AGENTS.md

This file is the **source of truth** for coding agents and humans working in the `packages/file-explorer-ui` package. It’s opinionated, production-grade, and scoped to **this package only** (the monorepo root has its own AGENTS.md).

---

## What this package is

A set of **React 19+** components, hooks, and tiny stores that render a fast, accessible **file explorer UI** with large-tree virtualization, tri-state selection, preview/table views, and a tabbed file viewer. It sits on top of:

* `@brainstrike/file-explorer` (Zustand store factory)
* `@brainstrike/file-explorer-hooks` (adapters, utilities)
* `@brainstrike/file-system` (abstracted FS)
* `@brainstrike/workers` (content loading worker)
* `@brainstrike/ui` (shadcn/ui-like primitives)

It is **UI-only**. No business logic for embeddings, queueing, etc. lives here.

---

## Quick commands (from repo root or package dir)

* Install: `pnpm i`
* Build: `pnpm -w turbo run build --filter @brainstrike/file-explorer-ui` (or `pnpm build` in this dir)
* Dev (watch): `pnpm dev`
* Typecheck: `pnpm type-check`
* Lint: `pnpm lint`
* Tests (unit): `pnpm test`
* Coverage (split): `pnpm test:coverage` or monorepo’s `test:coverage` targets

> CI requires build, types, lint, and tests to pass. No “temporary” workarounds.

---

## Public surface (what you can import)

From `src/index.ts`:

* Components

  * `FileExplorerSidebar`, `FileExplorerLeftPanel`, `FileExplorerMiddlePanel`, `FileExplorerMiddlePanelTabbed`
  * `FileTree`, `OptimizedFileTree`
  * `WorktreeIndexingControl`
  * `PreviewPanel`, `PreviewPanelSummary`, `TabbedFileEditor`, `TabbedFileEditorPanel`
  * `SelectionCounter`
  * Config/controls: `WorkspaceSettings`, `FileFilterBar`, `ViewFilterPresetDropdown`, `IncludeProjectTreeSetting`, `MaxSelectionCountSetting`, `FolderSummaryThresholdSetting`
* Providers & hooks

  * `FileExplorerProvider`, `useFileExplorerStoreContext`
  * `useFileExplorer`, `useFileTree`, `useFileSystem`, `useSelectionManager`
  * Content helpers: `FileContentProvider`, `useFileContentContext`, `useSharedFileContentLoading`
* Utilities

  * `processDirectoryEntry`, `processFileEntry`, `readFullTree`
  * `utils/file-node-cache`, `utils/file-content-worker`

If a component isn’t exported here, treat it **internal**.

---

## Minimal embedding example

```tsx
import { AdaptersProvider } from "@brainstrike/file-explorer-hooks";
import { MemoryStorageAdapter } from "@brainstrike/storage";
import { FileExplorerProvider, FileExplorerLeftPanel, FileExplorerMiddlePanelTabbed } from "@brainstrike/file-explorer-ui";

export default function Explorer() {
  return (
    <AdaptersProvider
      fileSystemAdapter={/* platform-specific FS adapter */}
      storageAdapter={new MemoryStorageAdapter()}
    >
      <FileExplorerProvider storageAdapter={new MemoryStorageAdapter()}>
        <div className="grid grid-cols-3 h-dvh">
          <aside className="col-span-1 border-r"><FileExplorerLeftPanel /></aside>
          <main className="col-span-2"><FileExplorerMiddlePanelTabbed /></main>
        </div>
      </FileExplorerProvider>
    </AdaptersProvider>
  );
}
```

---

## Architecture you must not break

### 1) Store & context

* We instantiate a **scoped Zustand store** via `FileExplorerProvider`. Do **not** import or mutate the global store; always use `useFileExplorerStoreContext()`.
* Selectors must use `createWithEqualityFn` or `shallow` where appropriate to prevent re-renders on large trees. See Zustand docs for `createWithEqualityFn` and `useShallow`. ([Zustand Documentation][1])
* `FileExplorerProvider` owns the persisted-state recovery notification. It
  atomically consumes the core store's redacted `persistenceRecoveryNotice`
  and shows one informational toast: saved explorer settings were reset, while
  user files were not changed. The toast must never include the rejection
  reason, persisted values, root identifiers, or paths. Missing first-run state
  and valid hydration remain silent.

### 2) Virtualization / treegrid

* File-tree virtualization is owned by shared **TreeTable** primitives (`packages/ui/src/tree-table/*`), not a package-local virtual-list hook. `OptimizedFileTree` adapts explorer rows onto TreeTable (`windowingStrategy="virtual"`).
* Keep `ROW_HEIGHT` consistent across trees; changing row height requires changes in TreeTable consumers and tests.
* Prefer adapting feature surfaces to the TreeTable API over duplicating tree render / virtualization logic here (root AGENTS.md TREEGRID CONVERGENCE CONTRACT).
* `TreeTableViewport` owns both scroll axes and is the virtualizer scroll element. Explorer adapters must stay layout-only (`overflow-hidden`) so the native horizontal scrollbar remains at the panel bottom and the semantic sticky header stays bound to the actual scrollport.
* For large DOMs, prefer CSS containment (`contain`, `content-visibility`) and GPU-friendly transforms when profiling says it helps. (Use judiciously—don’t paper over logic bugs.) ([GitHub][2])

### 3) File content loading

* `useSharedFileContentLoading` batches `FileReadRequest`s to a worker created by `@brainstrike/workers/file-content-worker` with concurrency derived from `navigator.hardwareConcurrency`.
* Per-file results stream back; we keep a `loadingFiles` set and write content into the store.
* Load generations, active-read promises, the bounded batch queue, and the immutable per-composite-key error projection are owned once by `FileExplorerProvider`, not by each `useSharedFileContentLoading` hook. Every loader under one provider must consult that shared authority before committing content or errors, because the file-content store/cache is shared. The underlying LRU is itself store-owned; provider replacement creates a new store/cache and authority atomically. Refresh starts idle keys immediately in one batch, groups dependent keys by the exact preceding promise, and starts each group independently when that promise settles (including rejection) after filtering superseded generations. At most TWO worker queues run per provider lifecycle epoch: this leaves one lane for unrelated work when an older queue is slow while bounding a 20-group settlement burst. Queue class is explicit logical intent, NEVER inferred from a physical group's key count: tab open/Retry are `interactive`, preview/report and watcher refresh are `background`, and every predecessor group carries its originating intent even when it contains one key. Two consecutive interactive dispatches while background waits force one background dispatch. Preparation uses per-key settlement so valid siblings still read; preparation/worker failures clear every affected loading marker and set errors only for current failed keys. Every physical group settles before the public logical request rejects, and a later successful sibling cannot erase an earlier failure for another key. A retry clears only its requested keys at the logical request boundary. The error map is a live projection, not history: a key is retained only while its read is active or an explicit consumer owns it. Its aggregate `error` object is memoized by the immutable error-map snapshot so value-equivalent rerenders do not manufacture a new error identity. `WorkspaceTabsProvider` synchronously owns exactly the open-tab composite keys (the tab store's hard maximum is 20), so close, bulk close, hydration, eviction, unmount, and reset prune retired terminal errors without hiding an active tab's error. Unowned report/preview failures remain observable through the rejected request and are pruned when that request releases. `WorkspaceTabsProvider` projects the active owned key's error into `FileTabBody`'s accessible terminal error screen; content failures are never promoted to the explorer's global error surface. `trackActiveLoad`/`releaseActiveLoad` are explicit test-only predecessor seams; production reads enter through `scheduleBatch`.
* Preview reads and context export have separate visible-failure owners. Direct preview rejection retries the exact failed keys. Copy/download retain report-manager toasts while returning a typed outcome; `FileExplorerMiddlePanelBase` stores the exact action plus a deep snapshot of its options and retries the WHOLE export only while the value-equivalent selection snapshot remains authoritative. Selection authority compares canonical set membership, not `Set` object identity, because multi-root projections may recreate an equivalent set. Report generation receives the raw background loader, so nested missing-content work cannot replace an export failure with a content-only retry. Copy/download alerts and controls are labelled distinctly; raw internal error text stays in logs rather than UI copy.
* `FileContentErrorScreen` is actionable: it shows the selected path and a bounded safe error category, and its Retry button calls `reloadFileContents([compositeKey], 'interactive')`. Never render the raw loader error message or re-enter the automatic load loop at the terminal-error boundary.
* Only the explicit `readFileByAbsolutePath(absolutePath, mountedRootPath, rootId)` adapter method grants handleless native-path authority; desktop carries all three values through a distinct visible-UI-only IPC call. Main exact-maps RootId, verifies the claimed presentation/canonical path belongs to that SAME live mount, then confines the requested file. Duplicate aliases and symlink/junction retargets must never select authority by path insertion order. During async desktop boot, an open tab whose exact root descriptor has not arrived stays unloaded rather than receiving a sticky inaccessible sentinel; the workspace tab effect depends on root descriptors and retries when authority arrives. A legacy path-shaped composite key still fails visibly once the descriptor projection is authoritative. `readFileByPath` is adapter-defined and the real web adapter uses it for root-relative browser-handle resolution, so its presence MUST NOT route into the desktop branch. Direct-path-capable adapters do not require a populated tree to finish a load or refresh. The dev fixture decorator preserves this capability boundary while routing fixture-owned absolute paths to fixture bytes and delegating foreign paths to the underlying capability. Each direct worker request carries its durable rootId and mounted root, and both the worker and adapter reject blank identity or blank/nonabsolute root/file arguments before I/O; the native non-registry adapter explicitly validates rootId but retains rootPath as its confinement authority. The native adapter reads the canonical path returned by validation, never the original alias. The worker never falls back to generic `readFileByPath` when the explicit capability is absent. `resolveDirectReadPath` preserves POSIX `/`, Windows drive roots, and UNC shares; relative paths must contain no empty, control, `.` or `..` segments, while absolute paths must be contained by the selected root using POSIX case-sensitive or drive/UNC case-insensitive comparison. Reject unsafe paths visibly—never reinterpret an outside absolute path as relative and never fall back to concatenation. Web missing/lazy nodes remain on the cached-handle permission path even when the adapter also implements `readFileByPath`. Structured worker `inaccessible` results are canonicalized with `buildInaccessibleContent`; the exact binary sentinel is preserved so `FileTabBody` continues to route it to `BinaryFilePreview`.
* The two-lane content scheduler is a concurrency bound, not a liveness timeout. `FileContentWorker` accepts an optional `AbortSignal`, but this loader currently supplies no controller and has no content-read timeout or user-cancel policy. If TWO adapter reads never settle, both provider lanes remain occupied, keys sharing either predecessor remain coupled, and queued batches/logical waiters remain pending. Do not invent an elapsed-time cutoff: adding a safe bound requires an explicit cancellation owner/trigger and adapter cancellation contract.
* Queue class comes only from caller intent, never key count: singleton preview/report/refresh work stays `background`; only tab open and explicit tab Retry are `interactive`. If an interactive caller requests a key already queued inside a background ticket, extract that exact key into a NEW interactive tail ticket—even when it was the background ticket's only key—and keep the original logical request dependent on it. Never mutate the old queue position, promote unrelated bulk companions, or read the key twice. Explicit Retry promotes/joins before beginning any replacement generation, while watcher refresh keeps predecessor-replacement semantics. The promoted key takes the next free provider lane without preempting either live lane. FIFO holds within each class, and one waiting background batch runs after at most two consecutive interactive dispatches so interactive traffic cannot starve background progress. Reset/unmount settles every queued, promoted, and active ticket once and clears their ownership maps; late physical completion remains generation-fenced.
* Factory reset calls the same authority's invalidation before clearing all store content/cache and selections, then advances the provider lifecycle key. Web reset therefore remounts hook-local loading refs/state even without a page reload. Provider identity replacement also changes that key and commit-phase cleanup invalidates the retired authority, so late callbacks cannot mutate the replacement lifecycle.
* Rebuilt `FileHandle`s forward `fileNode.handle.rootId` as the durable read authority when present. `rootFolderId` remains selection/cache identity and must never be substituted for `rootId`.
* “Binary file” and “not accessible” markers are **string content** (UI treats them specially). Don’t change those strings without updating tests/UI.

### 4) Progress & cancellation

* Cancel signals are propagated via `AbortController`.
* There is no shared loading-overlay component. `LoadingOverlay` — and the
  `useCancelButtonDelay` / `useKeyboardCancellation` / `useProgressMessage`
  hooks that served its ETA and Escape-to-cancel affordances — were deleted in
  BST-965 after turning out to have no mounting site. Surfaces render their own
  progress UI (see `restoration-status.tsx`, `scanning-status.tsx`).

### 5) FS adapters & permissions

* Browser builds rely on the **File System Access API** (Chrome/Edge et al.). The UX must respect permission prompts and error mapping (permission denied, dialog failures). Don’t bypass those guardrails or you’ll ship a broken experience across browsers. ([Chrome for Developers][4])
* `FILE_EXPLORER_REFRESH_EVENT` may carry capped per-root
  `filteredChangeBoundaries` plus explicit boundary overflow. This is scoped
  Git freshness from the concrete main Explorer watcher's explicit
  `reportDefaultFilteredChanges:true` opt-in, not watcher record loss or a
  generic adapter default. Explorer tree/index/metadata consumers use only
  detailed `changes` and must not turn boundary-only evidence into a full scan.

---

## Accessibility (non-negotiable)

We implement a **WAI-ARIA tree view** and a tri-state selection model. If you touch it, match the spec:

* Tree semantics: container `role="tree"`, rows `role="treeitem"`, nested items reflect hierarchy, use `aria-expanded` for directories. Keyboard: ↑/↓ move focus; → expands (and moves), ← collapses; Home/End; `*` may expand siblings. Follow WAI-ARIA APG. ([W3C][5])
* Tri-state checkboxes for directories: use `aria-checked="mixed"` (or the native input’s `indeterminate`) and ensure assistive tech announces the state. ([MDN Web Docs][6])
* Tabs: the tab button must have `role="tab"` and pair with a `role="tabpanel"` via `aria-controls` / `aria-labelledby`.
* Use **Playwright role locators** (`getByRole`) in E2E; avoid brittle CSS/XPath. ([Playwright][7])

---

## React 19 specifics

React 19 ships improved transitions and form handling. We rely on React 19+ throughout; don’t downgrade. If you add async transitions for long tasks, prefer React’s built-in patterns rather than custom spinners littered across components. Check the 19.0+ release notes and versions matrix when changing peer ranges. ([React][8])

---

## Performance playbook

Do these before reaching for cleverness:

1. **Minimize re-renders**

   * Use store selectors with equality functions; memoize props for row components; avoid inline arrow functions in hot lists unless `useCallback` + stable deps. Zustand explains preventing re-renders via selectors. ([Zustand Documentation][1])

2. **Virtualize aggressively**

   * Keep overscan low (2–3) unless measuring shows churn; prefer absolute positioning + a single translated container.

3. **Contain & early exit**

   * For very large trees, `contain: layout paint style` on the scroller—and when beneficial, `content-visibility: auto` with measured intrinsic size to reduce layout cost. Measure before/after. ([DEV Community][9])

4. **Cap payloads**

   * We hard-cap preview text to \~200k chars per panel and mark truncation.

5. **Defer heavy work**

   * Use `useDeferredValue` in preview/table transformations (already applied); keep grouping/sorting pure and memoized.

6. **Testing signals**

   * If E2E flakes: revisit focus management and role attributes first. Then examine virtualization thresholds. For Playwright, stick to `getByRole` with accessible names. ([Playwright][7])

---

## Security & privacy

### Core Security Requirements
* **No secrets in client bundles.** `VITE_*` environment values are bundled and
  are not secret storage; use a host bridge or secure host-owned storage.
* **Input validation** for all user-provided data (file paths, search queries, filter inputs).
* **Proper error handling** without information leakage—don't expose internal paths or stack traces.
* **Dependencies scanned** for vulnerabilities using `pnpm audit` and automated scanning in CI.

### File System Security
* File paths must be **validated and sanitized** before operations.
* **Path traversal prevention** - validate file paths to prevent directory traversal attacks.
* **File type validation** - ensure only safe file types are processed for preview.
* **Permission checks** - verify file access permissions before operations.

### Content Security
* Preview content should **not** execute code or load external resources.
* **Content sanitization** - sanitize file content before rendering in preview panels.
* **XSS prevention** - escape user content and use safe rendering methods.
* **Resource loading restrictions** - prevent loading of external resources in previews.

### Data Privacy Protection
* Never persist raw file **contents** to durable storage from this package. Store contents in memory or ephemeral workers only.
* Selection paths are persisted by `@brainstrike/file-explorer` as local user
  state. Do not add file contents to that persisted snapshot, and do not copy
  persisted paths into logs, diagnostics, or remote payloads without an
  explicit contract.
* **Memory cleanup** - dispose of file content and sensitive data promptly.
* **Cache management** - implement secure caching with appropriate expiration.
* **User data isolation** - ensure user data doesn't leak between sessions.

### Development Security Practices
* **Secret management warnings** - prominently display warnings about hardcoded credentials.
* **Dependency security scanning** - run `pnpm audit` before commits and in CI.
* **Error boundary implementation** - prevent sensitive information from leaking through error messages.
* **Secure defaults** - all security-sensitive features should default to the most secure option.
* Be explicit about error messages; we intentionally map browser FS errors to friendly strings (permission denied, dialog issues).
* Respect the File System Access model: require user gestures for new handles; don't auto-re-prompt. ([Chrome for Developers][4])

---

## Testing guidance

* Unit tests live alongside sources under `src/**/__tests__/**`. Keep them fast (happy-dom/jsdom).
* E2E (Playwright) in apps; when writing new tests here, prefer **role-based locators** and **user-facing names**; avoid fragile CSS chaining. Read Playwright’s best-practices. ([Playwright][10])

---

## Component contracts (what agents can rely on)

### FileTree / OptimizedFileTree

* Props: `{ fileTree: IFileNode[]; loadingFiles: Set<string>; folderId: string; onRender? }`
* Rows use `ROW_HEIGHT = 32`. Changing that means updating virtualization math + tests.
* Directory selection is **tri-state** and operates on **visible children**; bulk operations respect `maxSelectionCount`.

### PreviewPanel

* Inputs: `selectedFiles (Set<string>)`, `fileContents`, `loadingFiles`, `onSelectionChange(Set)`, `decodeFileSelection`, `tokenCounting`, `performUndoableAction`
* Grouping presets (folder/fileType/sizeSteps/tokenSteps) are declarative in `utils/grouping-configs`. Add new groups there—**don’t** fork logic in the component.

### TabbedFileEditor

* Restores scroll from `editor-view-state-store`.
* Owns no tab chords: ⌘/Ctrl+W, Ctrl+PgUp/PgDn and the rest belong to the tab chord router in `packages/app-shell/src/tab-chords/`, which drives the workspace strip through `useWorkspaceTabs()`.
* Calls `onLoadFileContent(compositeKey)` whenever an active tab is missing content (and not already loading).

---

## Patterns & recipes

### Add a new column in PreviewPanel

1. Extend `TableRowData`.
2. Populate the field in the mapping that converts `flatListItems` → `TableRowData`.
3. Add a `COLUMN_CONFIGS` entry with `canHide`, `defaultVisible`.
4. Respect persisted `ColumnVisibility` and ensure sorting function handles nulls.

### Add a new grouping mode

1. Add an entry in `GROUPING_CONFIGS` with `id`, `label`, and a `groupBy(item)` function.
2. Provide a `sortGroups` if ordering matters.

### Optimize selection in big directories

* For batch add/remove use store actions: `addMultipleSelectedFiles(folderId, paths)` and `removeMultipleSelectedFiles(...)`; do **not** loop through `toggleSelectedFile` in the UI thread.

### Introduce a new FS platform adapter (web/desktop)

* Provide it via `AdaptersProvider`.
* Ensure `DirectoryHandle` and `FileHandle` carry `platform` and `_internal` shape the worker knows how to read.

---

## “Don’t break these invariants”

* **ARIA semantics** for tree, tabs, and checkboxes must remain correct (APG-compliant). ([W3C][5])
* **Treegrid / virtualization contract**: explorer trees must use shared TreeTable (`packages/ui/src/tree-table/*`) as the canonical treegrid; do not reintroduce a local `use-virtual-list`. Preserve WAI-ARIA treegrid semantics and keep `ROW_HEIGHT` aligned with TreeTable consumers.
* **Max selection** is enforced **before** mutating selection sets.
* **Binary content** and **not accessible** markers are strings the UI recognizes; don’t change without updating all consumers/tests.

---

## When you add features

**Performance checklist**

* [ ] Added/updated memoization for heavy maps/reductions.
* [ ] Verified store selectors use equality functions (`createWithEqualityFn`, `useShallow`). ([Zustand Documentation][1])
* [ ] Confirmed virtualization still renders <= \~150 rows at a time at typical viewport sizes.
* [ ] Measured before/after (React Profiler, Performance panel).

**Accessibility checklist**

* [ ] Tree items have proper roles/attrs; keyboard permutations verified. ([W3C][5])
* [ ] Mixed checkbox states announce correctly (`aria-checked="mixed"` or native `indeterminate`). ([MDN Web Docs][6])
* [ ] Tab↔panel a11y wiring is intact; focus is preserved across updates.

**Testing checklist**

* [ ] Unit tests for new selectors/edge cases.
* [ ] Playwright E2E uses `getByRole`, not CSS. ([Playwright][7])

---

## Notes on large-tree UX

* Keep **overscan minimal**; it matters more than you think.
* Sorting/grouping runs on **table data**, not the raw tree. This keeps the tree pipeline simple.
* Avoid “live” heavy regex while typing; debounce and pre-validate.
* Consider **content visibility** and **containment** when rendering massive tables or nested panes; benchmark changes, don't cargo-cult. ([DEV Community][9])

---

## References (for further reading)

* **WAI-ARIA Tree View pattern** and **Keyboard practices** — the canonical source for our a11y contracts. ([W3C][5])
* **Tri-state checkboxes** (`aria-checked="mixed"`) semantics on APG & MDN. ([W3C][11])
* **React 19** features blog & versions page. ([React][8])
* **Zustand re-render control** (`createWithEqualityFn`, `useShallow`). ([Zustand Documentation][1])
* **File System Access API** (Chrome docs & WICG). ([Chrome for Developers][4])
* **Playwright best practices & role locators**. ([Playwright][10])
* **Virtualization guidance** (TanStack Virtual & CSS containment notes). ([TanStack][3])

---

This file is **living documentation**. Update it whenever:

* public exports change,
* we add grouping/sorting modes,
* accessibility behavior changes,
* virtualization math or constants change, or
* FS adapters/permissions behavior changes.

Be blunt: if a change hurts perf or a11y, call it out here and fix it before shipping.

[1]: https://zustand.docs.pmnd.rs/apis/create-with-equality-fn "createWithEqualityFn ⚛️ - Zustand"
[2]: https://github.com/petyosi/react-virtuoso/discussions/959 "Offloading virtualization to the browser via CSS Containment"
[3]: https://tanstack.com/table/v8/docs/guide/virtualization "Virtualization Guide | TanStack Table Docs"
[4]: https://developer.chrome.com/docs/capabilities/web-apis/file-system-access "The File System Access API: simplifying access to local files"
[5]: https://www.w3.org/WAI/ARIA/apg/patterns/treeview/ "Tree View Pattern | APG | WAI"
[6]: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/checkbox_role "ARIA: checkbox role - MDN - Mozilla"
[7]: https://playwright.dev/docs/locators "Locators"
[8]: https://react.dev/blog/2024/12/05/react-19 "React v19"
[9]: https://dev.to/mnathani/two-lines-of-css-that-boosts-7x-rendering-performance-4mjd "Two lines of CSS that boosts 7x rendering performance!"
[10]: https://playwright.dev/docs/best-practices "Best Practices"
[11]: https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/examples/checkbox-mixed/ "Checkbox Example (Mixed-State) | APG | WAI"
