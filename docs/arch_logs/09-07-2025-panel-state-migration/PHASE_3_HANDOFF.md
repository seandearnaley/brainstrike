# Phase 3 Handoff: Root Tabs Conditional Mounting

Status: ✅ COMPLETED — Ready for Phase 4
Developer: Feature state slices can be migrated next

## 🎯 What Phase 3 Delivered

Replaced root-level tab visibility hacks in `RootLayoutContent` with proper conditional mounting and store-driven navigation. The explorer and settings sections now mount/unmount based on the canonical `activeTab` in the panel layout store. Panel layout persistence remains controlled via the provider with the store as the single source of truth.

## 📁 Key Files Modified

```
packages/app-shell/src/root-layout-content.tsx  # Conditional mount + controlled PanelLayoutProvider
packages/app-shell/src/__tests__/root-layout-content.test.tsx  # Updated assertions for presence/absence
```

## 🔧 Technical Details

- Navigation: `AppLayout` still supplies `onNavigationClick`; handler writes to store `activeTab`.
- Rendering:
  - Explorer section renders only when `activeTab === 'explorer'`.
  - Settings section renders only when `activeTab === 'settings'`.
  - Both sections retain `data-testid` for E2E and tests.
- Controlled Provider:
  - `PanelLayoutProvider` receives `controlledState` from the store:
    - `sizes`, `showConsole`, `showLeftPanel`, `showRightPanel`.
  - `onChange` maps the provider state back into the store via `setState`, normalizing `sizes` to a 3-tuple.
- The previously nested uncontrolled provider usage was removed inside RootLayoutContent (no adapter needed in controlled mode).

## ✅ Tests

- Updated unit tests to check for presence/absence instead of `hidden/block` classes.
- All app-shell unit tests pass locally.

Run focused:

```bash
pnpm -w run test --filter @brainstrike/app-shell
```

## 🧭 What’s Next (Phase 4 Targets)

- Identify components within panels/console that need state persistence across unmounts and lift into light Zustand slices (e.g., editor cursor/selection, search query).
- Keep selectors stable (primitives/tuples) for React Compiler/HMR friendliness.

## 🧪 Validation Snapshot

- Type check: `pnpm -w run type-check` (green)
- Unit tests: `pnpm -w run test --filter @brainstrike/app-shell` (green)
- E2E smoke: pending — verify rapid tab switching and panel toggling persists sizes/state correctly in web and desktop.

---

Handoff complete ✅ — Proceed to Phase 4 to migrate feature state out of component lifetimes.

