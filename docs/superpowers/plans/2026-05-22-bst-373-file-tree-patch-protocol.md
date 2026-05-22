# BST-373 File Tree Patch Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace routine file-tree worker full-tree result payloads with explicit patch protocol messages for loaded children, node load-state changes, expanded-path deltas, and flattened rows.

**Architecture:** Keep the worker as the owner of transferable file-tree state, but move operation results to patch streams consumed by the typed port. The port accumulates patches for promise-based operations so React consumers can update normalized tree state without receiving a full worker tree at completion. Initial `treeSnapshot` remains valid only for startup/recovery.

**Tech Stack:** TypeScript, Web Worker `postMessage`, React hook consumers, Vitest.

---

### Task 1: Protocol Types And Worker Red Tests

**Files:**
- Modify: `packages/file-tree-worker/src/types.ts`
- Modify: `packages/file-tree-worker/src/bfs-engine.test.ts`
- Modify: `packages/file-tree-worker/src/file-tree.worker.test.ts`

- [x] **Step 1: Write failing tests**

Add tests asserting:
- `handleLoadResult()` emits `nodeLoadStateChanged` and `childrenLoaded`.
- `expandAll()` completion has only `expandedPaths` and `loadedCount`, not a full `tree`.
- `flattenTree()` emits `flattenedRows`.
- `updateTree` emits a patch message instead of a routine full `treeSnapshot`.

- [x] **Step 2: Run red tests**

Run:
```bash
pnpm --filter @brainstrike/file-tree-worker vitest run src/bfs-engine.test.ts src/file-tree.worker.test.ts src/port.test.ts
```
Expected: fail because patch message types and payload shapes do not exist yet.

### Task 2: Worker Patch Emission

**Files:**
- Modify: `packages/file-tree-worker/src/types.ts`
- Modify: `packages/file-tree-worker/src/bfs-engine.ts`
- Modify: `packages/file-tree-worker/src/file-tree.worker.ts`

- [x] **Step 1: Add protocol types**

Define `ChildrenLoadedPatchMessage`, `NodeLoadStateChangedPatchMessage`, `ExpandedPathsDeltaMessage`, and `FlattenedRowsMessage`. Add a `FileTreePatchMessage` union for port accumulation.

- [x] **Step 2: Emit minimal patches**

Update `BFSEngine` so load-state transitions post `nodeLoadStateChanged`, successful child loads post `childrenLoaded`, completion posts `expandedPathsDelta` plus a tree-free `complete`, and flattening posts `flattenedRows`.

- [x] **Step 3: Keep startup/recovery full snapshots only**

Keep `treeSnapshot` for `init`, and replace `collapseAll`/`updateTree` routine snapshots with `expandedPathsDelta`/`childrenLoaded`.

### Task 3: Port And React Consumer Adaptation

**Files:**
- Modify: `packages/file-tree-worker/src/port.ts`
- Modify: `packages/file-tree-worker/src/port.test.ts`
- Modify: `packages/file-explorer-ui/src/tree/use-lazy-file-tree.ts`

- [x] **Step 1: Accumulate operation patches in the port**

Change pending operation results from `{ tree, expandedPaths, loadedCount }` to `{ patches, expandedPaths, loadedCount }`, and collect patch messages while an operation is active.

- [x] **Step 2: Apply patches to normalized UI state**

In `use-lazy-file-tree.ts`, rehydrate patch children with the handle map and apply them with existing normalized tree helpers. Use returned `expandedPaths` for expansion commit.

- [x] **Step 3: Preserve explicit failure behavior**

Throw when any child patch cannot be rehydrated, matching the existing no-silent-degradation full-tree count check.

### Task 4: Verification, Commits, And PR Proof

**Files:**
- Modify: `.ci/proof/latest.json` only in the proof commit if `pnpm ci:prove` writes it.

- [x] **Step 1: Run targeted package tests**

Run:
```bash
pnpm --filter @brainstrike/file-tree-worker vitest run src/bfs-engine.test.ts src/file-tree.worker.test.ts src/port.test.ts
```

- [x] **Step 2: Run affected consumer tests**

Run:
```bash
pnpm --filter @brainstrike/file-explorer-ui vitest run src/tree/use-lazy-file-tree.test.ts src/__tests__/use-file-tree-context.test.ts
```

- [ ] **Step 3: Run root gate**

Run:
```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

- [ ] **Step 4: Commit source changes**

Commit all source, tests, and this plan before creating the proof manifest.

- [ ] **Step 5: Run PR proof flow**

Run:
```bash
pnpm ci:select --base origin/main --head HEAD
pnpm ci:prove --base origin/main --head HEAD
pnpm ci:verify-proof --base origin/main --head HEAD --labels '<selected ci labels>'
```

Commit `.ci/proof/latest.json` alone after `ci:prove`, then push and open the PR with the selected `ci:*` labels.
