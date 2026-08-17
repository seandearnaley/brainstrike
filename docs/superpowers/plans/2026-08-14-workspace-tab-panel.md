# Unified Workspace Tab Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tab strip in the workspace panel header hosting closable singleton app tabs (Files/Changes/Canvas) plus file tabs, with an empty-state launcher, full persistence, and deleted-file marking.

**Architecture:** Promote `WorkspaceTabHost`'s machinery into a split controller/strip/body architecture: a `WorkspaceTabsProvider` (React context) above the outer `IdeLayout` owns orchestration; the strip renders in the panel header via a new `headerContent` chrome seam; the body renders mounted app surfaces keep-alive plus the active file tab. `workspace-panel-tabs.tsx` (outer Radix strip) is deleted; `changes-navigation-store` sheds tab routing; `workspace-tab-selection` store gains persisted `openAppIds` (v2).

**Tech Stack:** React 19, zustand (persist + merge), Radix-free hand-rolled tablist (APG), Tailwind v4, Vitest, Playwright.

**Tickets:** BST-1258 (epic) → BST-1259 (header seam), BST-1260 (stores), BST-1261 (apps registration), BST-1262 (visuals/launcher), BST-1263 (deleted files), BST-1264 (e2e).

## Global Constraints

- Branch: `feature/workspace-tab-panel`; single PR; conventional commits `type(BST-12xx): …`.
- TDD: every behavioral change lands test-first (red → green). Run tests from the owning package dir with `pnpm vitest run <file>`.
- App id `context-explorer` is frozen (DOM id + persistence key). Label changes to "Files".
- Store name strings are frozen (`workspace-tab-selection.v1` stays even at version 2).
- No `isElectron()` in shared code; capability gating = prop omission.
- Mount-once: an app surface, once mounted, never unmounts within a session (Canvas iframe, nested explorer layout state).
- No local tab state derived from props (React Doctor `no-adjust-state-on-prop-change`).
- Persist hydration via `merge` returning the complete persisted shape; never `onRehydrateStorage`.
- z-index only via `packages/ui/src/layers.ts`; strip must have no visible scrollbar.
- NO SILENT FALLBACKS: malformed persisted payloads coerce through validators; impossible states log + render explicit fallbacks.
- Gate: `pnpm build && pnpm lint && pnpm typecheck && pnpm test` green in the same run before PR; `pnpm dlx ultracite fix` before committing.

---

### Task 1: `workspace-tab-selection` store v2 — `openAppIds` + `empty` selection (BST-1260)

**Files:**
- Modify: `packages/file-explorer-ui/src/stores/workspace-tab-selection-store.ts`
- Test: `packages/file-explorer-ui/src/__tests__/stores/workspace-tab-selection-store.test.ts`

**Interfaces (produced):**
```ts
export type WorkspaceTabSelection =
  | { kind: 'app'; appId: string }
  | { kind: 'file'; tabId: string }
  | { kind: 'empty' };

interface WorkspaceTabSelectionState {
  readonly openAppIds: readonly string[];
  readonly selection: WorkspaceTabSelection;
  /** Open (add if missing) AND activate an app tab. Singleton: re-open activates. */
  openApp: (appId: string) => void;
  /** Alias of openApp — kept for existing call sites; identical semantics. */
  selectApp: (appId: string) => void;
  selectFile: (tabId: string) => void;
  /**
   * Close an app tab. If it was selected, selection moves to the adjacent open
   * app (next, else previous); with no open apps left, selection becomes
   * `{kind:'empty'}`. Returns the successor appId or null (caller may then
   * prefer a file tab — the store cannot see file tabs).
   */
  closeApp: (appId: string) => string | null;
  /** Explicit empty selection (used by controller fallbacks). */
  selectEmpty: () => void;
  /** Factory reset. */
  reset: () => void;
}
```
Persisted shape v2: `{ openAppIds: string[], selection }`. Migration from v1 (`{ selection }`): `openAppIds = ['context-explorer']`, plus the persisted app selection's id if it's a different app. Invariant enforced by `coercePersisted`: a `kind:'app'` selection's `appId` is always a member of `openAppIds` (append if missing); `openAppIds` deduped, strings only. Default state: `openAppIds: ['context-explorer']`, selection = Files app (unchanged default view).

**Steps:**

- [ ] **Step 1: Write failing tests** (replace/extend the existing store test file; keep passing v1 cases where still valid):

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../../stores/workspace-tab-selection-store';

beforeEach(() => __resetWorkspaceTabSelectionStoreForTests());

describe('openApp / singleton semantics', () => {
  it('adds the app once and selects it', () => {
    const s = useWorkspaceTabSelectionStore.getState();
    s.openApp('changes');
    s.openApp('changes');
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
      'context-explorer',
      'changes',
    ]);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'changes',
      kind: 'app',
    });
  });
});

describe('closeApp', () => {
  it('selects the adjacent open app and returns it', () => {
    const s = useWorkspaceTabSelectionStore.getState();
    s.openApp('changes');
    s.openApp('canvas'); // open: [ce, changes, canvas], selected canvas
    const successor = useWorkspaceTabSelectionStore.getState().closeApp('canvas');
    expect(successor).toBe('changes');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'changes',
      kind: 'app',
    });
  });
  it('closing the last open app yields empty selection and null successor', () => {
    const successor = useWorkspaceTabSelectionStore.getState().closeApp('context-explorer');
    expect(successor).toBeNull();
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([]);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ kind: 'empty' });
  });
  it('closing a background app leaves the current selection alone', () => {
    const s = useWorkspaceTabSelectionStore.getState();
    s.openApp('changes');
    s.selectFile('tab-1');
    useWorkspaceTabSelectionStore.getState().closeApp('changes');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'tab-1',
    });
  });
});

describe('persistence migration + coercion', () => {
  it('migrates a v1 payload to openAppIds seeded with context-explorer', () => {
    // exercised through the persist `migrate`/`merge` pipeline:
    const migrated = useWorkspaceTabSelectionStore.persist.getOptions().migrate?.(
      { selection: { appId: 'context-explorer', kind: 'app' } },
      1
    );
    expect(migrated).toEqual({
      openAppIds: ['context-explorer'],
      selection: { appId: 'context-explorer', kind: 'app' },
    });
  });
  it('coerces an app selection whose id is missing from openAppIds', () => {
    // malformed localStorage: selection points at an app not in the open list
    const merged = useWorkspaceTabSelectionStore.persist.getOptions().merge?.(
      { openAppIds: [], selection: { appId: 'canvas', kind: 'app' } },
      useWorkspaceTabSelectionStore.getState()
    );
    expect(merged?.openAppIds).toContain('canvas');
  });
  it('falls back to defaults on garbage payloads', () => {
    const merged = useWorkspaceTabSelectionStore.persist.getOptions().merge?.(
      { openAppIds: 'nope', selection: 42 } as never,
      useWorkspaceTabSelectionStore.getState()
    );
    expect(merged?.openAppIds).toEqual(['context-explorer']);
    expect(merged?.selection).toEqual({ appId: 'context-explorer', kind: 'app' });
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/__tests__/stores/workspace-tab-selection-store.test.ts` from `packages/file-explorer-ui` — expect FAIL (openApp undefined).
- [ ] **Step 3:** Implement v2 store (full rewrite of the file): `version: 2`, `migrate(persisted, fromVersion)` handling v1, `partialize: (s) => ({ openAppIds: s.openAppIds, selection: s.selection })`, `merge` running `coercePersisted` (complete shape), actions per the interface above. `closeApp` successor rule: index-based — prefer `openAppIds[i]` after removal at the same index (the next tab), else the new last entry, else null. Keep the store-name string `'workspace-tab-selection.v1'`.
- [ ] **Step 4:** Re-run tests — PASS. Also run the whole package: `pnpm vitest run` (expect failures ONLY in files this plan later migrates; note them, don't fix here if they're behavioral changes scheduled for Tasks 3–5 — but compile errors from the changed types must be fixed now by updating call sites minimally).
- [ ] **Step 5:** Commit `feat(BST-1260): workspace tab selection v2 with persisted openAppIds`.

---

### Task 2: `IdeLayout` — `headerContent` chrome seam + `inheritFileEditorContext` (BST-1259)

**Files:**
- Modify: `packages/ui/src/layout/ide-layout.tsx`
- Test: `packages/ui/src/__tests__/ide-layout.test.tsx` (append cases)

**Interfaces (produced):**
- `PanelChromeConfig` gains `headerContent?: React.ReactNode` (right panel only consumes it for now). When present, the header row renders `headerContent` in place of the icon+title block, inside a `min-w-0 flex-1` container; the collapse button remains after it.
- `IdeLayoutProps` gains `inheritFileEditorContext?: boolean`. When true, the component does NOT create its own `IdeFileEditorContext` value; it re-provides the parent context value, so `useIdeFileEditor()`/`registerOpenFileInTab` inside its subtree hit the parent layout's seam.

**Steps:**

- [ ] **Step 1: Failing tests** (append to `ide-layout.test.tsx`, using its existing render helpers):

```tsx
it('renders rightPanelChrome.headerContent in the right panel header and keeps the collapse button', () => {
  render(
    <IdeLayout
      rightPanelChrome={{
        headerContent: <div data-testid="custom-header-strip">strip</div>,
        hideButtonTestId: 'hide-x',
        title: 'ShouldNotRender',
      }}
      rightPanelContent={<div>tools</div>}
    >
      <div>main</div>
    </IdeLayout>
  );
  const header = screen.getByTestId('right-panel-header');
  expect(within(header).getByTestId('custom-header-strip')).toBeInTheDocument();
  expect(within(header).queryByText('ShouldNotRender')).not.toBeInTheDocument();
  expect(within(header).getByTestId('hide-x')).toBeInTheDocument();
});

it('inheritFileEditorContext reuses the parent layout file-open seam', () => {
  const opened: string[] = [];
  function OuterRegister() {
    const { registerOpenFileInTab } = useIdeFileEditor();
    useEffect(() => registerOpenFileInTab((key) => opened.push(key)), [registerOpenFileInTab]);
    return null;
  }
  function InnerOpener() {
    const { openFileInTab } = useIdeFileEditor();
    return <button onClick={() => openFileInTab?.('k1')} type="button">open</button>;
  }
  render(
    <IdeLayout rightPanelContent={<div />}>
      <OuterRegister />
      <IdeLayout inheritFileEditorContext rightPanelContent={<div />}>
        <InnerOpener />
      </IdeLayout>
    </IdeLayout>
  );
  fireEvent.click(screen.getByText('open'));
  expect(opened).toEqual(['k1']);
});
```

- [ ] **Step 2:** `pnpm vitest run src/__tests__/ide-layout.test.tsx` from `packages/ui` — FAIL.
- [ ] **Step 3:** Implement. Header hunk (right panel, ~L1377): replace the icon+title `<div className="flex items-center gap-2">` with:

```tsx
{resolvedRightPanelChrome.headerContent ? (
  <div className="flex h-full min-w-0 flex-1 items-stretch">
    {resolvedRightPanelChrome.headerContent}
  </div>
) : (
  <div className="flex items-center gap-2">
    <RightPanelIcon className="size-3.5" />
    <span className="font-medium text-xs">{resolvedRightPanelChrome.title}</span>
  </div>
)}
```
Also drop the header's horizontal padding to `pr-2 pl-0` when `headerContent` is present (tabs sit flush left) and keep `justify-between`. For the context inherit: capture `const parentFileEditorValue = useContext(IdeFileEditorContext);` and provide `inheritFileEditorContext ? parentFileEditorValue : fileEditorContextValue`.
- [ ] **Step 4:** Tests PASS; run the package suite `pnpm vitest run` in `packages/ui` (layout tests are extensive — all green).
- [ ] **Step 5:** Commit `feat(BST-1259): IdeLayout headerContent seam + inherited file-editor context`.

---

### Task 3: Split `WorkspaceTabHost` into controller + strip + body; closable app tabs; launcher (BST-1261/1262)

**Files:**
- Create: `packages/file-explorer-ui/src/shell/workspace-tabs-context.tsx` (controller/provider; all orchestration formerly in `WorkspaceTabHost`)
- Create: `packages/file-explorer-ui/src/shell/workspace-tab-strip.tsx` (strip; app + file tabs; overflow menu; scroll mechanics)
- Create: `packages/file-explorer-ui/src/shell/workspace-body.tsx` (keep-alive app panels, active file body, launcher)
- Create: `packages/file-explorer-ui/src/shell/workspace-launcher.tsx` (empty-state cards)
- Create: `packages/file-explorer-ui/src/shell/file-tab-body.tsx` (move `FileTabBody`, `getDisplayContent`, `NoFileTabSelected` etc. out of the 1350-line host — file-split rule)
- Modify: `packages/file-explorer-ui/src/shell/workspace-app.ts` (docs only: apps are now closable singletons, not "pinned, non-closable")
- Delete (end of task): `packages/file-explorer-ui/src/shell/workspace-tab-host.tsx`
- Modify: `packages/file-explorer-ui/src/shell/index.ts` (exports)
- Test: migrate `packages/file-explorer-ui/src/__tests__/workspace-tab-host.test.tsx` → `workspace-tabs.test.tsx` (provider+strip+body rendered together in a harness that mirrors real composition: strip and body as SIBLING subtrees under the provider)

**Interfaces (produced):**
```tsx
// workspace-tabs-context.tsx
export interface WorkspaceTabsProviderProps {
  readonly apps: readonly WorkspaceApp[]; // registry order = canonical display order
  readonly children: ReactNode;
}
export function WorkspaceTabsProvider(props: WorkspaceTabsProviderProps): ReactElement;
export function useWorkspaceTabs(): WorkspaceTabsValue; // throws outside provider (no silent fallback)

export interface WorkspaceTabsValue {
  readonly apps: readonly WorkspaceApp[];
  readonly openApps: readonly WorkspaceApp[];      // registry order ∩ openAppIds
  readonly mountedAppIds: ReadonlySet<string>;     // sticky within session
  readonly tabs: readonly FileTab[];
  readonly selection: WorkspaceTabSelection;
  readonly tabStatuses: Map<string, TabFileStatus>;
  readonly loadingFiles: Set<string>;
  readonly fileContents: { readonly [key: string]: string };
  readonly isRestoring: boolean;
  readonly rootDescriptors: FileExplorerState['rootDescriptors'];
  readonly getTabStatusMessage: (compositeKey: string) => string | null;
  readonly onOpenApp: (appId: string) => void;
  readonly onCloseApp: (appId: string) => void;
  readonly onSelectFileTab: (tabId: string) => void | Promise<void>;
  readonly onCloseFileTab: (tabId: string) => void;
  readonly onCloseOtherFileTabs: (tabId: string) => void;
  readonly onCloseFileTabsToRight: (tabId: string) => void;
  readonly onCloseAllFileTabs: () => void;
  readonly handleOpenFileInTab: OpenFileInTab;     // for the bridge component
}

// Registers handleOpenFileInTab into the NEAREST IdeFileEditorContext — mount inside the outer IdeLayout.
export function WorkspaceOpenFileBridge(): null;
```
Behavioral deltas vs the old host (everything else carries over verbatim — restoration, permission flow, hotkeys, cycle, reconcile-after-bulk-close, selection intent ref, dead-selection effect):
1. `mountedAppIds` sticky set: grows when `selection` lands on an app (and seeds with the active app on first render). Never shrinks (session keep-alive).
2. Close-file fallback (single AND bulk AND restoration): successor file tab → else adjacent logic: if any `openApps` remain, `selectApp(openApps[0].id)`… **No** — prefer the app the user most recently used: keep it simple and deterministic: `openApps[0]` (registry order) if any, else `selectEmpty()`.
3. Dead-selection effect generalizes: file selection with no matching tab → same fallback as (2); app selection whose id is NOT in `openAppIds` → same fallback (can happen via cross-window storage edits).
4. Ctrl/Cmd+W (desktop): file selection closes the file tab (unchanged); app selection now closes the app tab (`onCloseApp`) — it's closable now, and this matches the thread-tab precedent. Still no `preventDefault` on web.
5. `onCloseApp(appId)`: `const successor = closeApp(appId); if (successor === null) { const { activeTabId } = useTabManagerStore.getState(); if (activeTabId) { selectFile(activeTabId); } }` — file tabs win over the empty state when apps run out.

```tsx
// workspace-tab-strip.tsx — key DOM contract (testids unchanged where they exist today)
// <div data-testid="workspace-tab-strip" role="tablist" aria-label="Workspace tabs"> …
//   app tabs: data-testid={`workspace-app-tab-${app.id}`}, closable (X appears on hover/active,
//     aria-label={`Close ${app.label}`}, data-testid={`workspace-app-tab-close-${app.id}`}),
//     icon-forward "pill" treatment: rounded-md bg-primary/10 text-primary when active;
//     muted pill otherwise. Distinct from file tabs (border-b indicator, no pill).
//   file tabs: unchanged structure/testids (workspace-file-tab-${id}) with FileTabIcon states.
//   scroller: data-testid="workspace-tab-scroll" — overflow-x-auto with hidden scrollbar
//     ([scrollbar-width:none] + [&::-webkit-scrollbar]:hidden), wheel→horizontal handler,
//     chevron buttons data-testid="workspace-tabs-scroll-left|right" appearing only when
//     scrollWidth > clientWidth (ResizeObserver + scroll listener), active tab scrollIntoView
//     ({behavior: reducedMotion ? 'auto' : 'smooth', inline: 'nearest'}).
//   zero open tabs: renders <span className="px-3 text-xs font-medium">Workspace</span> only.
//   overflow menu ("More tab actions") unchanged.
//   Keyboard: roving tabIndex (active tab 0, rest -1), ArrowLeft/Right/Home/End move focus+select,
//     Delete closes focused tab (file or app) — mirrors assistant-thread-tabs-workspace.tsx.
```

```tsx
// workspace-body.tsx — key DOM contract
// Renders inside the panel content area:
//   for each app of apps where mountedAppIds.has(app.id):
//     <div role="tabpanel" id={`workspace-app-panel-${app.id}`}
//          aria-labelledby={`workspace-app-tab-${app.id}`}
//          hidden={!(selection.kind === 'app' && selection.appId === app.id)}
//          className="h-full data-[hidden=true]:hidden"> {app.render()} </div>
//     (render() result cached per app id — same memo-by-id contract as the old WorkspaceBody)
//   active file tab: unchanged FileTabBody path (role=tabpanel, keyed by compositeKey).
//   selection.kind === 'empty' (or app/file selection unresolvable): <WorkspaceLauncher />.
```

```tsx
// workspace-launcher.tsx
export function WorkspaceLauncher(): ReactElement;
// data-testid="workspace-launcher"; one button card per registered app:
// data-testid={`workspace-launcher-open-${app.id}`}, icon (size-8), label, one-line description
// (Files: "Browse and open workspace files" / Changes: "Review agent and git changes" /
//  Canvas: "View canvases created by the agent"); onClick → onOpenApp(app.id).
// Layout: centered flex-col, cards in a responsive row (flex-wrap, gap-3), each card:
// rounded-lg border bg-card hover:bg-accent/50 transition-colors p-4 w-40 text-left,
// focus-visible ring. Muted "Open a surface to get started" heading above.
```

**Steps:**

- [ ] **Step 1:** Create `workspace-tabs.test.tsx` by copying `workspace-tab-host.test.tsx` and rewriting the harness: render `<WorkspaceTabsProvider apps={apps}><WorkspaceTabStrip /><WorkspaceBody /></WorkspaceTabsProvider>` inside the existing provider mocks (file explorer context, IdeFileEditor provider wrapper for the bridge). Add NEW failing cases:
  - app tab close button closes the app; strip loses the tab; body shows launcher when nothing else is open;
  - closing the active app with a file tab open selects the file tab;
  - launcher card `workspace-launcher-open-context-explorer` re-opens Files;
  - apps render in registry order regardless of open order;
  - switching from Files to a file tab and back does NOT remount the Files surface (mount-count probe component inside `apps[0].render()`);
  - a `not-found` tab stays in the strip (no auto-close) — moved fully to Task 5 but the harness must not assert the old auto-close behavior;
  - `useWorkspaceTabs` outside provider throws.
- [ ] **Step 2:** `pnpm vitest run src/__tests__/workspace-tabs.test.tsx` — FAIL (modules don't exist).
- [ ] **Step 3:** Implement the four new files by MOVING code from `workspace-tab-host.tsx` (git-friendly: keep function bodies byte-identical where behavior is unchanged). `FileTabBody` + helpers (`getDisplayContent`, `getFileName`, `getTabRootPath`, `isDesktopRenderer`, `NoFileTabSelected`, `MissingAppFallback`, `FileTabIcon`) move to `file-tab-body.tsx`. Keep the `FileTabBodyForTesting` export. Delete `workspace-tab-host.tsx`; update `shell/index.ts` exports (`WorkspaceTabsProvider`, `WorkspaceTabStrip`, `WorkspaceBody`, `WorkspaceOpenFileBridge`, `WorkspaceLauncher`, keep `WorkspaceApp`/`CONTEXT_EXPLORER_APP_ID`). The Files app definition (`CONTEXT_EXPLORER_APP`) moves OUT of file-explorer-ui — app-shell now owns the registry (Task 4); file-explorer-ui exports `ContextExplorerAppBody` (thin wrapper re-exporting `FileExplorerMiddlePanelBase`) from `shell/index.ts` for the app wrappers.
- [ ] **Step 4:** Package suite green: `pnpm vitest run` in `packages/file-explorer-ui`.
- [ ] **Step 5:** Commit `feat(BST-1261): split workspace tabs into controller/strip/body with closable app tabs and launcher`.

---

### Task 4: app-shell rewiring — apps registry, header hoist, store slimming, factory reset (BST-1261)

**Files:**
- Modify: `packages/app-shell/src/agent-workspace-layout.tsx` (add `workspaceHeaderContent` prop → `rightPanelChrome.headerContent`)
- Modify: `packages/app-shell/src/root-layout-content.tsx` (`ExplorerAppSurface` + `ContextExplorerSurface`)
- Delete: `packages/app-shell/src/workspace-panel-tabs.tsx`, `packages/app-shell/src/__tests__/workspace-panel-tabs.test.tsx`
- Modify: `packages/app-shell/src/changes/changes-navigation-store.ts` (drop `activeWorkspacePanelTab`/`canvasTabMounted`/`changesTabMounted`; `openChangeset`/`openCanvasPanel` call the selection store)
- Modify: `packages/app-shell/src/register-factory-reset-session-stores.ts` (register selection-store reset; tab-manager reset)
- Modify: `apps/web/src/app/context-explorer-page-content.tsx`, `apps/desktop/src/renderer/components/context-explorer-page-content.tsx` (render `ContextExplorerAppBody`)
- Tests: `packages/app-shell/src/__tests__/root-layout-content.test.tsx`, `.../agent-workspace-layout.test.tsx`, `packages/app-shell/src/changes/__tests__/changes-navigation-store.test.ts`

**Interfaces (consumed):** Task 1 store actions, Task 2 seams, Task 3 components.

**Target composition (ExplorerAppSurface):**
```tsx
const workspaceApps = useMemo<readonly WorkspaceApp[]>(() => {
  const apps: WorkspaceApp[] = [
    {
      icon: Files,                       // lucide 'Files'
      id: CONTEXT_EXPLORER_APP_ID,
      label: 'Files',
      render: () => (
        <ContextExplorerSurface
          contextExplorerPageContent={contextExplorerPageContent}
          contextExplorerPanelContent={contextExplorerPanelContent}
          loadEmbeddingQueue={loadEmbeddingQueue}
        />
      ),
    },
  ];
  if (changesPageContent) {
    apps.push({ icon: GitCompare, id: 'changes', label: 'Changes', render: () => changesPageContent });
  }
  if (canvasPanelContent) {
    apps.push({ icon: PanelsTopLeft, id: 'canvas', label: 'Canvas', render: () => canvasPanelContent });
  }
  return apps;
}, [contextExplorerPageContent, contextExplorerPanelContent, loadEmbeddingQueue, changesPageContent, canvasPanelContent]);

return (
  <div className="h-full min-h-0" data-testid="explorer-section">
    <FileTreeWrapper>{/* hoisted from ContextExplorerSurface */}
      <MarkdownPreviewCapabilitiesProvider capabilities={markdownPreviewCapabilities}>{/* hoisted */}
        <WorkspaceTabsProvider apps={workspaceApps}>
          <AgentWorkspaceLayout
            assistantContent={…unchanged…}
            sidebarContent={…unchanged…}
            workspaceHeaderContent={<WorkspaceTabStrip />}
            workspaceContent={
              <>
                <QuickOpenHost />{/* moved: now reaches the OUTER IdeLayout's file-open seam */}
                <WorkspaceOpenFileBridge />
                <WorkspaceBody />
              </>
            }
          />
        </WorkspaceTabsProvider>
      </MarkdownPreviewCapabilitiesProvider>
    </FileTreeWrapper>
  </div>
);
```
`ContextExplorerSurface` changes: loses `FileTreeWrapper` + `MarkdownPreviewCapabilitiesProvider` + `QuickOpenHost` (hoisted); its nested `IdeLayout` gains `inheritFileEditorContext` so tree/search file opens inside the Files app hit the outer seam; children = `contextExplorerPageContent` only. `AgentWorkspaceLayout` keeps title `'Workspace'` in chrome (fallback when strip renders its own label is fine — strip owns the label per Task 3).

`changes-navigation-store.ts`: delete the three tab fields + `setActiveWorkspacePanelTab` + `WorkspacePanelTab` type export; `openCanvasPanel: () => { useWorkspaceTabSelectionStore.getState().openApp('canvas'); }`, `openChangeset: (changeset) => { get().requestChangeset(changeset); useWorkspaceTabSelectionStore.getState().openApp('changes'); }` (import from `@brainstrike/file-explorer-ui` package subpath). `reset()` drops the removed fields. Grep for all consumers of the removed symbols (`rg -n "activeWorkspacePanelTab|WorkspacePanelTab|TabMounted" packages apps`) and migrate them.

Factory reset: in `register-factory-reset-session-stores.ts` add a block calling `useWorkspaceTabSelectionStore.getState().reset()` and `useTabManagerStore.getState().clearTabs()` via package subpaths (comment: persisted stores' localStorage is cleared by the blanket wipe, but the LIVE instances must reset for the no-reload web path — `resetDatabaseDemoStoreToDefault` precedent).

**Steps:**

- [ ] **Step 1: Failing tests first.**
  - `agent-workspace-layout.test.tsx`: `workspaceHeaderContent` renders inside `right-panel-header`.
  - `root-layout-content.test.tsx`: replace `WorkspacePanelTabs` expectations — mock `@brainstrike/file-explorer-ui/shell` (`WorkspaceTabsProvider`/`Strip`/`Body`/bridge as passthrough stubs recording props); assert: registry has 1 app on "web" prop-shape, 3 on "desktop" prop-shape with ids `['context-explorer','changes','canvas']` and label `Files`; no `workspace-panel-tabs` testid anywhere.
  - `changes-navigation-store.test.ts`: `openChangeset` calls `useWorkspaceTabSelectionStore` `openApp('changes')` (assert via the real store's state: `openAppIds` contains `'changes'`, selection is the changes app); same for `openCanvasPanel`; removed fields gone.
- [ ] **Step 2:** Run the three test files — FAIL.
- [ ] **Step 3:** Implement all modifications above; delete `workspace-panel-tabs.tsx` + its test; update both app wrappers to `import { ContextExplorerAppBody } from '@brainstrike/file-explorer-ui/shell'` and render `<ContextExplorerAppBody className="h-full" />`.
- [ ] **Step 4:** `pnpm vitest run` green in `packages/app-shell`; `pnpm typecheck` at repo root to catch cross-package breakage (apps compile).
- [ ] **Step 5:** Commit `feat(BST-1261): register Changes/Canvas as workspace apps and hoist the strip into the panel header`.

---

### Task 5: Deleted files stay as marked tabs (BST-1263)

**Files:**
- Modify: `packages/file-explorer-ui/src/shell/workspace-tabs-context.tsx` (drop the `onTabNotFound` auto-close callback — pass nothing to `useTabFileRestoration`)
- Modify: `packages/file-explorer-ui/src/shell/workspace-tab-strip.tsx` (not-found file tab: `AlertCircle` icon already handled by `FileTabIcon`; add `data-state="not-found"` attr for e2e/styling and `aria-label` suffix `" (deleted)"`)
- Test: `packages/file-explorer-ui/src/__tests__/workspace-tabs.test.tsx`

**Steps:**

- [ ] **Step 1: Failing test:** with restoration reporting `not-found` for a tab, the tab REMAINS in the strip with `data-state="not-found"` and selecting it renders the "File Not Found" body; it can be closed manually.
- [ ] **Step 2:** Run — FAIL (current callback closes it).
- [ ] **Step 3:** Implement (delete the callback + strip attr).
- [ ] **Step 4:** Package tests green. Also verify `packages/file-explorer-hooks` suite still green (`use-tab-file-restoration` untouched — callback param stays optional).
- [ ] **Step 5:** Commit `feat(BST-1263): keep deleted files as marked tabs instead of auto-closing`.

---

### Task 6: Repo-wide gate + stale-test sweep

- [ ] **Step 1:** `rg -n "workspace-panel-tabs|WorkspacePanelTabs|activeWorkspacePanelTab|changesTabMounted|canvasTabMounted|workspace-app-tab-context-explorer" packages apps --glob '!**/dist/**'` — migrate every remaining reference (known: `packages/app-shell/src/__tests__/root-layout-content.test.tsx`, desktop e2e `database-persistence.test.ts`, web e2e specs — e2e handled in Task 7).
- [ ] **Step 2:** From repo root, same run: `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — all green. `pnpm run react-doctor` — no new error-severity issues.
- [ ] **Step 3:** `pnpm dlx ultracite fix` on touched files; commit `test: migrate remaining suites to unified workspace tabs`.

---

### Task 7: Playwright e2e (web) + spec migration (BST-1264)

**Files:**
- Create: `apps/web/e2e/workspace-tabs.test.ts`
- Modify: `apps/web/e2e/utils/app-state.ts` (add `'tab-manager.v1'`, `'workspace-tab-selection.v1'` to `APP_STATE_KEYS`)
- Modify: `apps/web/e2e/layout.test.ts`, `layout-persistence.test.ts`, `file-preview.test.ts`, `panel-state-preservation.test.ts`, `navigation-panel-state-preservation.test.ts` (single strip, header placement, `Files` label)

**New spec outline (each is a test):**
1. Strip renders inside `right-panel-header`; exactly one `workspace-tab-strip` in the document; Files app tab present with label "Files".
2. Open a file from the tree (`mockBrowserApis` fixture) → `workspace-file-tab-*` appears in the header strip; body shows the file.
3. Close Files app tab + all file tabs → `workspace-launcher` visible; click `workspace-launcher-open-context-explorer` → Files tab returns.
4. Persistence: open a file + reload → tab and active selection restored (localStorage `workspace-tab-selection.v1` v2 payload).
5. Collapse (`hide-workspace-panel`) and re-expand (`show-workspace-panel`) still work with the strip in the header.
6. No horizontal scrollbar: strip scroller has no visible scrollbar (assert computed `scrollbar-width: none` or webkit pseudo hidden) while overflowed with many tabs.

**Steps:**

- [ ] **Step 1:** Write the new spec + migrations (red where behavior is new).
- [ ] **Step 2:** `pnpm build` then `pnpm --filter @brainstrike/web test:e2e -- --project=functional` (full functional lane locally; fix until green).
- [ ] **Step 3:** Commit `test(BST-1264): e2e coverage for the unified workspace tab panel`.

---

### Task 8: Manual Chrome DevTools verification (definition of done for UI work)

- [ ] Launch web dev server; drive the real app with Chrome DevTools MCP: open files, switch apps, close everything, launcher, reload persistence, collapse/expand, dark + light, narrow panel widths. Screenshot each state. Fix any visual defect found, with a unit/e2e test where the defect class is testable.
- [ ] Commit any fixes.

### Task 9: Docs + PR

- [ ] Update `docs/agents/ui-conventions.md` (context-action section: app tabs are closable singletons, still non-file targets) and `docs/agents/explorer-search-tapestry.md` if it names the tab host; update `docs/agents/changeset-diff.md` entry-point description (`openChangeset` now opens the app tab). Same-change doc+test rule.
- [ ] Push branch, `gh pr create` (title `feat(BST-1258): unified workspace tab panel`, body with spec/plan links, ticket list, test evidence, screenshots). Monitor bot reviews + checks; respond/resolve with diff notes.
