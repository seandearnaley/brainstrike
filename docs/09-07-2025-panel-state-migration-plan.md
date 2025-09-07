## September 7, 2025 - Panel State Migration Plan (Q4 2025)

Purpose: eliminate “keep mounted but invisible” hacks, lift UI state into canonical stores (Zustand), and move panels/tabs to controlled rendering with safe unmounts. This plan is self‑contained to enable handoff to agents/contractors.

### Scope
- Core hotspots identified:
  - `packages/app-shell/src/root-layout-content.tsx` (tab visibility via `hidden`/`block`)
  - `packages/ui/src/layout/ide-layout.tsx` (panels rendered even when hidden; relies on `collapsedSize=0`)
  - `packages/ui/src/layout/left-panel.tsx`, `right-panel.tsx` (collapsible panels remain mounted)
- Library: `react-resizable-panels@3.0.4` (confirmed in lockfile)

---

### Phase 0 — Readiness & Baseline
- [ ] Confirm current green state
  - [x] pnpm type-check (per package) — no errors
  - [x] pnpm lint — clean
  - [x] pnpm test (unit/integration) — 100% (app-shell including new store tests)
  - [x] pnpm test:e2e (headless) — green (web)
  - [x] Manual smoke test (tabs + panels)
- [ ] Create feature branch: `refactor/panel-state-migration`
- [ ] Snapshot current IDE layout behavior (screens, short clip)

Outputs
- [ ] Baseline report in PR description (versions, green checks)

Validation checkpoint
- Build, lint, unit, e2e must stay green throughout. Stop and rollback if not.

---

### Phase 1 — Define Canonical Panel/Tab State in Store
- [x] Introduce centralized Zustand slice (or extend existing) for panel + tab state
  - [x] State: `sizes: [number, number, number]`, `showLeftPanel`, `showRightPanel`, `showConsole`
  - [x] State: `activeTab: 'explorer' | 'settings'` (or enum-like union type)
  - [x] Actions: `setSizes`, `toggleLeft`, `toggleRight`, `toggleConsole`, `setActiveTab`
  - [x] Persistence wiring: use existing `PanelLayoutProvider` adapter contracts (via storage adapters)
- [x] Document store contract in this file and JSDoc in store file

Files
- [ ] New/updated: `packages/ui/src/providers/panel-layout-provider.tsx` (controlled mode support already present)
- [x] New: `packages/app-shell/src/stores/panel-layout-store.ts`

Outputs
- [x] Store file with typed API and tests
  - JSDoc header + handoff doc: `docs/09-07-2025-panel-state-migration/PHASE_1_HANDOFF.md`

Validation checkpoint
- [x] Unit tests for store actions and persistence adapter interaction

---

### Phase 2 — Convert IdeLayout to Controlled Rendering
- [x] Update `IdeLayout` to consume only controlled props via `PanelLayoutProvider` or explicit props
  - [x] Render panel content only when visible: conditionally mount `LeftPanel`, `RightPanel`, `ConsolePanel`
  - [x] Remove reliance on “collapsed but mounted” for persistence; persistence lives in store
  - [x] Keep resize behavior intact by saving sizes on `onLayout`
- [x] Ensure safe unmount for each panel: move panel-local UI state to the store if needed (e.g., form inputs) — N/A in wrappers; feature slices handled in Phase 4

Files
- [x] Edit: `packages/ui/src/layout/ide-layout.tsx`
- [ ] Edit: `packages/ui/src/layout/left-panel.tsx`, `right-panel.tsx` (no changes required)

Outputs
- [x] IdeLayout renders only visible panels; hidden panels are unmounted

Validation checkpoint
- [x] Unit tests for `IdeLayout` resized layout callbacks and visibility
- [x] E2E smoke: toggle panels; sizes persist; reload restores (covered by web E2E layout tests)

---

### Phase 3 — Replace Root Tab Hidden/Block Toggle
- [x] In `RootLayoutContent`, replace `className={activeTab === '...'? 'block' : 'hidden'}` with conditional mount/unmount
  - [x] Lift any child local state (forms, in-progress inputs) into a small tab slice or reuse existing stores — N/A
  - [x] Ensure costly data (e.g., file handles) persists via store, not component lifetimes — handled via existing feature stores
- [x] Keep navigation controlled by store `activeTab`

Files
- [x] Edit: `packages/app-shell/src/root-layout-content.tsx`

Outputs
- [x] Inactive tab unmounts cleanly; state preserved in store

Validation checkpoint
- [x] E2E: navigate between tabs rapidly; verify no data loss
- [x] Unit/integration: tab state reducers/selectors (updated unit tests)

---

### Phase 4 — Migrate Panel/Console Feature State
- [x] Identify panel-contained components with internal state that must persist across unmounts
  - [x] Quick filter (file explorer) — migrated to store and persisted
  - [x] Editor view state (scroll position) — migrated to store and persisted
  - [ ] Editor cursor/selection (pending)
  - [ ] Inspector form values (pending)
- [x] Create minimal persisted slices (Zustand) for each needed feature
  - Quick filter added to existing File Explorer store (persisted)
  - Editor view state slice added in file-explorer-ui (persisted)
- [ ] Add selectors to keep React Compiler/HMR friendly (tuple or primitives, stable shape)

Files
- [ ] Feature slices colocated near features (e.g., `file-explorer`/`inspector` packages)

Outputs
- [ ] Documented slices with tests; components read from store and can unmount safely
- [x] Quick filter persists across panel unmounts/reloads; E2E green
- [x] Editor scroll position persists across unmounts/reloads; unit tests added

What’s left in Phase 4 (before Phase 5)
- Editor cursor/selection: if/when a real editor is introduced (e.g., Monaco/CodeMirror), persist per-tab `{cursor, selectionRanges}` in a small zustand slice keyed by compositeKey. Acceptance: switch tabs/hide panel/reload without losing caret/selection.
- Inspector form values (if added later): co-locate a minimal slice per form (primitives/tuples only), persist on change, restore on mount. Acceptance: hide/show panel and reload without losing input values.
- Stable selectors: add tuple/primitives selectors where components currently consume objects from slices to avoid object churn and stay React Compiler friendly.

Validation checkpoint
- [ ] Unit tests per feature slice
- [ ] Targeted E2E where user flows cross hide/show cycles

---

### Phase 5 — Remove Residual Visibility Hacks
- [x] Search and remove `hidden`/`block` used for long‑lived component state — none remaining
- [x] Keep responsive `hidden sm:inline` for text/icons (allowed; purely presentational)
- [x] Confirm no inline `display:none`/Presence `forceMount`/keepMounted patterns exist

Outputs
- [x] PR notes: Visibility hacks removed; presentational-only `hidden/*` remain. Stores now own persistence.

Validation checkpoint
- [x] grep checks show only presentational `hidden` remains

---

### Cut Lines & Handoffs
Each phase is a safe merge point. Keep PRs small, include context for agents.

- After Phase 1
  - [x] Store exists with tests; no UI changes yet
- After Phase 2
  - [x] `IdeLayout` controlled and conditionally mounted; panels safe to unmount
- After Phase 3
  - [x] Root tabs unmount inactive content; state in store
- After Phase 4
  - [ ] Feature states persisted; UX parity verified
- After Phase 5
  - [x] Repo free of persistence‑via‑visibility hacks

---

### Developer Pointers (Context for Agents)
- Use existing provider/contracts: `PanelLayoutProvider`, `usePanelPersistence`, adapters (LocalStorage/Electron)
- Prefer controlled mode via provider + a single source of truth (Zustand)
- Selectors: return tuples/primitives, fixed arity; avoid object churn
- React Compiler/HMR: don’t change hook order; keep dependency arrays stable
- Testing:
  - Vitest unit/integration co‑located with sources
  - Playwright E2E headless; prefer role/text/data-testid selectors
  - Run per package with Turborepo filters
- CI expectations: build, types, lint, unit, e2e must remain green

---

### Validation Checklist (Run at End of Each Phase)
- [ ] pnpm run type-check
- [ ] pnpm run lint
- [ ] pnpm run test --filter <affected-pkgs>
- [ ] pnpm run test:e2e --filter @brainstrike/web (and desktop, if applicable)
- [ ] Manual smoke: panel toggles, resizes, reload persistence, tab switching

---

### Rollback Plan
- Revert to previous phase commit if regressions occur
- Preserve store contracts so subsequent phases remain compatible

---

### Appendix: References
- Files:
  - `packages/app-shell/src/root-layout-content.tsx`
  - `packages/ui/src/layout/ide-layout.tsx`
  - `packages/ui/src/layout/left-panel.tsx`, `right-panel.tsx`
  - `packages/ui/src/providers/panel-layout-provider.tsx`
- Library: `react-resizable-panels@3.0.4`
