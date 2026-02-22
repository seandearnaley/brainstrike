---
title: "Tree Grid Convergence Plan 2026 02 22"
---

# TreeGrid Convergence Plan (BST-312)

**Date:** 2026-02-22  
**Status:** Planned  
**Parent Ticket:** BST-312  
**Subtasks:** BST-313, BST-314, BST-315, BST-316, BST-317

## Objective

Converge these three surfaces onto one shared, production-ready TreeGrid foundation in `@brainstrike/ui`:

1. Collection Browser tree (`packages/ui/src/collection-browser/*` + `packages/ui/src/tree-table/*`)
2. File Explorer left tree (`packages/file-explorer-ui/src/optimized-file-tree*.tsx`)
3. Context Explorer preview table/grouped view (`packages/file-explorer-ui/src/preview-panel.tsx`, `preview-table.tsx`)

Target outcomes:

- One canonical tree/grid rendering core
- Feature parity across surfaces
- Better large-data UX (windowing strategy that supports both virtualization and pagination)
- Stronger performance and accessibility guarantees

## Current Baseline

### Existing implementations

- `TreeTable` in `@brainstrike/ui`:
  - virtualized treegrid (`@tanstack/react-virtual`)
  - keyboard nav, tri-state checkbox support, sort hooks, ARIA treegrid semantics
- `OptimizedFileTree` in `@brainstrike/file-explorer-ui`:
  - custom virtualization (`use-virtual-list`)
  - separate row/selection behavior and rendering path
- `PreviewTable` in `@brainstrike/file-explorer-ui`:
  - table + grouped rendering with explicit page slicing (`usePagination` + `TablePagination`)

### Main problems

- Maintenance divergence: behavior/perf fixes must be applied in multiple places.
- UX inconsistency: different selection/interaction semantics by panel.
- Performance tuning duplication: separate virtualization and pagination stacks.
- Extensibility risk: adding features (grouping, context markers, selection models) requires parallel implementations.

## Key Decision: Pagination + Virtualization, Not Either/Or

We will support both strategies via a shared API on TreeGrid.

### Proposed API

Add a windowing strategy on TreeGrid (`TreeTable`):

- `virtual`: existing virtualized behavior
- `paged`: page-sliced behavior using existing pagination primitives
- `auto`: strategy selected by runtime context

### Auto strategy policy

`auto` should default to:

- `virtual` for browse-heavy tree navigation (expand/collapse workflows)
- `paged` for search/result-heavy workflows where deterministic page semantics improve smoothness and selection predictability

Initial heuristic sources:

- active search mode (`quick` vs `semantic`)
- grouping state
- total visible row count
- explicit result-limit context from search config

Exact thresholds/constants will be finalized in BST-313 with tests and profiling.

## Architecture Direction

### 1. Canonical TreeGrid core in `@brainstrike/ui`

Extend `packages/ui/src/tree-table/*` to be the shared rendering + interaction engine.

Planned additions:

- Windowing strategy API (`virtual | paged | auto`)
- Optional pagination contract (adapter to `usePagination` + `TablePagination`)
- O(1) node lookup maps for hot handlers (replace repeated linear scans)
- Better separation between rendering, interaction handlers, and data shaping

### 2. Surface adapters (not forks)

Each consumer maps its domain model into TreeGrid contracts:

- Collection Browser adapter: existing path, strategy + perf improvements
- File Explorer adapter: map `IFileNode` + lazy-load/recursive-selection semantics
- Context Explorer adapter: map grouped table data into tree rows (group headers as parent rows)

### 3. Preserve existing shared utilities

- Continue using `usePagination` and `TablePagination`
- Reuse existing group/pagination helpers where valid (`preview-pagination.ts`), then retire duplication when fully superseded

## Feature Parity Contract

All migrated surfaces must support (where applicable):

- Expand/collapse and lazy loading
- Single/multi-select with tri-state parent behavior
- Search highlighting and context markers
- Keyboard navigation parity
- Grouping and group header collapse/expand
- Row double-click and context menu extension points
- Column sorting/visibility control behaviors

## Performance Contract

### Budgets and checks

- Keep/align with current performance budget utilities in `packages/utils/src/perf-timing.ts`.
- Keep existing tree E2E performance checks (`apps/web/e2e/performance/tree-rendering.test.ts`) green.
- Add focused tests for strategy switching and large result sets in `packages/ui/src/__tests__` and `packages/file-explorer-ui/src/__tests__`.

### Known hot-path improvements

- Replace repeated `rows.find(...)` / `nodes.find(...)` in row interaction and keyboard paths with O(1) maps built in memoized selectors.
- Ensure row-level props are stable to reduce virtual row churn.
- Verify grouped + paged operations avoid full-list recomputation on every interaction.

## Accessibility Contract

Maintain WAI-ARIA treegrid correctness while migrating:

- role/attribute semantics
- keyboard expectations
- tri-state checkbox announcements
- focus continuity through filtering/grouping/windowing changes

## Implementation Phases

### Phase 1 (BST-313): TreeGrid API + perf baseline

- Implement strategy API
- Add O(1) handler lookup paths
- Add tests for virtual/paged/auto behavior

### Phase 2 (BST-314): Collection Browser adoption

- Wire `auto` strategy
- Validate semantic search and grouped behavior

### Phase 3 (BST-315): File Explorer left tree migration

- Replace optimized file tree rendering path with TreeGrid adapter
- Preserve lazy-load and recursive folder selection semantics

### Phase 4 (BST-316): Context Explorer migration

- Replace preview table grouped rendering with TreeGrid-backed grouped rows
- Preserve page UX and bulk selection semantics

### Phase 5 (BST-317): hardening and verification

- Perf + accessibility regression coverage
- Docs updates
- Full quality gate run (build/lint/type-check/test/e2e)

## Verification Plan

Run full validation before merge:

```bash
pnpm build
pnpm lint
pnpm type-check
pnpm test
pnpm test:e2e
```

Package-focused iteration commands during development:

```bash
pnpm turbo run test --filter @brainstrike/ui
pnpm turbo run test --filter @brainstrike/file-explorer-ui
pnpm turbo run type-check --filter @brainstrike/ui
pnpm turbo run type-check --filter @brainstrike/file-explorer-ui
```

## Risks

- Behavior drift in directory tri-state selection during file tree migration
- Grouped pagination semantics changing in subtle ways in Context Explorer
- Regressions in keyboard focus/focus restoration during strategy switches

## Mitigations

- Phase-gated migration with adapter compatibility layers
- Add integration tests before removing legacy renderers
- Keep strategy default conservative (`auto` with measurable guardrails)

## Deliverables

- Shared TreeGrid strategy API and migration-ready adapters
- Legacy tree/table paths removed or reduced to thin compatibility wrappers
- Updated tests and docs
- Full green quality suite on final branch
