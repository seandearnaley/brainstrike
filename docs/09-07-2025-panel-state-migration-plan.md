## Panel State Migration Plan (Q4 2025)

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
  - [ ] pnpm type-check (per package) — no errors
  - [ ] pnpm lint — clean
  - [ ] pnpm test (unit/integration) — 100%
  - [ ] pnpm test:e2e (headless) — green
  - [ ] Manual smoke test (tabs + panels)
- [ ] Create feature branch: `refactor/panel-state-migration`
- [ ] Snapshot current IDE layout behavior (screens, short clip)

Outputs
- [ ] Baseline report in PR description (versions, green checks)

Validation checkpoint
- Build, lint, unit, e2e must stay green throughout. Stop and rollback if not.

---

### Phase 1 — Define Canonical Panel/Tab State in Store
- [ ] Introduce centralized Zustand slice (or extend existing) for panel + tab state
  - [ ] State: `sizes: [number, number, number]`, `showLeftPanel`, `showRightPanel`, `showConsole`
  - [ ] State: `activeTab: 'explorer' | 'settings'` (or enum-like union type)
  - [ ] Actions: `setSizes`, `toggleLeft`, `toggleRight`, `toggleConsole`, `setActiveTab`
  - [ ] Persistence wiring: use existing `PanelLayoutProvider` adapter contracts
- [ ] Document store contract in this file and JSDoc in store file

Files
- [ ] New/updated: `packages/ui/src/providers/panel-layout-provider.tsx` (controlled mode support already present)
- [ ] New: `apps/* or packages/*/src/stores/panel-layout-store.ts` (if not already centralized)

Outputs
- [ ] Store file with typed API and tests

Validation checkpoint
- [ ] Unit tests for store actions and persistence adapter interaction

---

### Phase 2 — Convert IdeLayout to Controlled Rendering
- [ ] Update `IdeLayout` to consume only controlled props via `PanelLayoutProvider` or explicit props
  - [ ] Render panel content only when visible: conditionally mount `LeftPanel`, `RightPanel`, `ConsolePanel`
  - [ ] Remove reliance on “collapsed but mounted” for persistence; persistence lives in store
  - [ ] Keep resize behavior intact by saving sizes on `onLayout`
- [ ] Ensure safe unmount for each panel: move panel-local UI state to the store if needed (e.g., form inputs)

Files
- [ ] Edit: `packages/ui/src/layout/ide-layout.tsx`
- [ ] Edit: `packages/ui/src/layout/left-panel.tsx`, `right-panel.tsx`

Outputs
- [ ] IdeLayout renders only visible panels; hidden panels are unmounted

Validation checkpoint
- [ ] Unit tests for `IdeLayout` resized layout callbacks and visibility
- [ ] E2E smoke: toggle panels; sizes persist; reload restores

---

### Phase 3 — Replace Root Tab Hidden/Block Toggle
- [ ] In `RootLayoutContent`, replace `className={activeTab === '...'? 'block' : 'hidden'}` with conditional mount/unmount
  - [ ] Lift any child local state (forms, in-progress inputs) into a small tab slice or reuse existing stores
  - [ ] Ensure costly data (e.g., file handles) persists via store, not component lifetimes
- [ ] Keep navigation controlled by store `activeTab`

Files
- [ ] Edit: `packages/app-shell/src/root-layout-content.tsx`

Outputs
- [ ] Inactive tab unmounts cleanly; state preserved in store

Validation checkpoint
- [ ] E2E: navigate between tabs rapidly; verify no data loss
- [ ] Unit/integration: tab state reducers/selectors

---

### Phase 4 — Migrate Panel/Console Feature State
- [ ] Identify panel-contained components with internal state that must persist across unmounts
  - [ ] Example: editor cursor/selection, search query, inspector form values
- [ ] Create minimal persisted slices (Zustand) for each needed feature
- [ ] Add selectors to keep React Compiler/HMR friendly (tuple or primitives, stable shape)

Files
- [ ] Feature slices colocated near features (e.g., `file-explorer`/`inspector` packages)

Outputs
- [ ] Documented slices with tests; components read from store and can unmount safely

Validation checkpoint
- [ ] Unit tests per feature slice
- [ ] Targeted E2E where user flows cross hide/show cycles

---

### Phase 5 — Remove Residual Visibility Hacks
- [ ] Search and remove `hidden`/`block` used for long‑lived component state
- [ ] Keep responsive `hidden sm:inline` for text/icons (allowed; purely presentational)
- [ ] Confirm no inline `display:none`/Presence `forceMount`/keepMounted patterns exist

Outputs
- [ ] PR notes listing removed hacks and their replacements (store references)

Validation checkpoint
- [ ] grep checks show only presentational `hidden` remains

---

### Cut Lines & Handoffs
Each phase is a safe merge point. Keep PRs small, include context for agents.

- After Phase 1
  - [ ] Store exists with tests; no UI changes yet
- After Phase 2
  - [ ] `IdeLayout` controlled and conditionally mounted; panels safe to unmount
- After Phase 3
  - [ ] Root tabs unmount inactive content; state in store
- After Phase 4
  - [ ] Feature states persisted; UX parity verified
- After Phase 5
  - [ ] Repo free of persistence‑via‑visibility hacks

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


