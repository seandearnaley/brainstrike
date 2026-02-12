---
title: "Window Resize Preparing Unsolved 2025 12 06"
---

# Handoff: Window Resize Layout Failure After Heavy File Processing - PARTIAL FIX

**Date**: 2025-12-06
**Status**: PARTIAL FIX - Debouncing implemented to reduce main thread pressure
**Branch**: `tweaks-for-progress`

## Problem Description

When resizing the Electron desktop window after loading a large directory (like the brainstrike monorepo with 17,000+ files), the content does not resize correctly. Instead:
- The dark mode UI remains frozen at dimensions calculated during load
- A white background "void" appears immediately upon resizing
- The layout appears completely broken/frozen

### CRITICAL CORRECTION (from original bug author)

**The previous debugging session operated under an incorrect assumption.**

- **WRONG assumption**: Bug isolated to "Preparing file tree..." intermediate phase
- **ACTUAL behavior (video evidence)**: Resize failure occurs AFTER the "Preparing" modal disappears (at timestamp 00:41 in recording)
- The main AppLayout/IdeLayout loses reactivity after heavy 17k file processing completes

This means all attempted fixes targeting the loading/preparing component lifecycle were investigating the wrong area entirely.

## What Was Tried (All Failed)

### 1-6. Various methods of forcing Reflow/Re-render (previous attempts)
*See previous attempts 1-6 in older history - essentially trying to force React to update on resize.*

### 7. Changing Root Layout to `fixed inset-0`
**Attempted**: Changed the root container in `RouterProvider` from `h-screen` (viewport units) to `fixed inset-0 h-full w-full` (absolute positioning). Also removed the ineffective forcing-reflow hooks.
**Hypothesis**: Viewport units might be failing or "stale" when the renderer is under heavy load. A fixed positioning context is often more robust in full-screen apps.
**Result**: Failed. The exact same symptoms persist (white void, frozen UI).

## Component Hierarchy (for reference)

```
RouterProvider (fixed inset-0 h-full w-full)
  └─ AppLayout (h-full flex-col)
      └─ IdeLayout (h-full flex-1, wrapped in React.memo)
          └─ PanelGroup (react-resizable-panels)
              └─ LeftPanel
                  └─ Panel (with flex)
                      └─ FileExplorerSidebar (h-full w-full)
                          └─ PreparingTreeState (h-full) OR OptimizedFileTree
```

## Relevant Technical Context

- **react-resizable-panels**: Used for the panel layout system. Note: Panel *dragging* works fine, so the library is active, but it may not be responding to *container* resize.
- **react-resizable-panels version**: 1.0.10 (from root package.json)
- **React Compiler**: Enabled in this project (automatic memoization)
- **`React.memo`**: IdeLayout is wrapped in React.memo
- **`useVirtualList`**: The OptimizedFileTree uses this hook which has its own ResizeObserver and window resize listener, but this component is NOT mounted during the "Preparing" phase

## Investigation Findings (2025-12-06 Update)

### Root Cause Analysis

The issue appears to be **main thread blocking** from heavy computation after loading completes. `react-resizable-panels` uses ResizeObserver internally, and if the main thread is blocked, ResizeObserver callbacks won't fire during window resize.

**Key sources of main thread blocking identified:**

1. **Token Cache Re-renders** (`packages/token-cache/src/use-token-cache.ts`)
   - `setVersion((v) => v + 1)` called at lines 162, 193, 281, 291, 302
   - Each resolved token triggers a re-render cascade
   - The `useMemo` at line 312 depends on `version`

2. **State Serialization** (`packages/file-explorer/src/persistence/state-serialization.ts`)
   - `Array.from()` on `selectedFilePaths` and `expandedDirectoryPaths` Sets
   - Runs on every Zustand persist (any state change)
   - O(n) for 17k+ entries

3. **File Filtering** (`packages/hooks/src/use-file-filters.ts`)
   - Synchronous `minimatch` calls on entire tree
   - `processTree` recursively iterates all nodes
   - Runs whenever filter dependencies change

4. **File Node Cache Building** (`packages/file-explorer-ui/src/utils/file-node-cache.ts`)
   - `buildFileNodeCache` recursively iterates entire tree
   - Runs in `useEffect` whenever `fileTree` changes (line 177-179 of `use-shared-file-content-loading.ts`)

5. **Preview Panel Computation** (`packages/file-explorer-ui/src/use-preview-panel-state.ts`)
   - `flatListItems` useMemo (lines 161-206) iterates all selected files
   - Depends on `tokenVersion` which increments on every token resolution
   - Creates new object references on each render

### Why Problem Scales with Folder Size

The following operations are O(n) where n = file count:
- `Array.from(expandedDirectoryPaths)` in serializeState
- `buildFileNodeCache` recursive population
- `applyFileFilters` tree traversal
- `flatListItems` iteration

### Proposed Solutions

1. **Debounce token version updates** - Batch `setVersion` calls to reduce re-renders
2. **Use Web Worker for serialization** - Move `serializeState` to background worker
3. **Lazy serialization** - Only serialize Sets when they actually change (track with version number)
4. **Filter memoization** - Cache filtered results by input hash
5. **Incremental tree building** - Use WeakMap for node caching instead of rebuilding

### Files to Modify

- `packages/token-cache/src/use-token-cache.ts` - Add debouncing
- `packages/file-explorer/src/persistence/state-serialization.ts` - Optimize serialization
- `packages/file-explorer-ui/src/use-preview-panel-state.ts` - Batch token version updates
- `packages/hooks/src/use-file-filters.ts` - Add caching layer

## Recommendations for Next Steps

**Investigation should focus on:**

- **react-resizable-panels behavior**: Why does `PanelGroup` (or its parent) stop resizing when the window resizes?
    - Does `PanelGroup` cache the container size?
    - Is there a race condition where the heavy file load keeps the main thread busy during a critical resize initialization?
- **Render Cycle Interruption**: Is there a silent error or boundary catching an update during resize?
- **Memory Pressure**: Does processing 17k files cause an OOM-like state where `ResizeObservers` are garbage collected or stopped?

## How to Test

1. Build the desktop app: `pnpm build`
2. Start the desktop app with a large directory (like brainstrike with 17k files) pre-saved in preferences
3. **Wait for the tree to fully load** (wait for "Preparing file tree..." to disappear)
4. Resize the Electron window
5. Observe that content does not resize correctly (white void appears, UI frozen at previous dimensions)

## Implemented Fixes (2025-12-06)

### 1. Debounced Token Version Updates in `use-preview-panel-state.ts`

Added debouncing (100ms) to prevent rapid-fire re-renders when tokens resolve:

```typescript
/** Debounce delay for token version updates (ms) */
const TOKEN_VERSION_DEBOUNCE_MS = 100;

const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const handleTokenResolved = useCallback(() => {
  if (!isMountedRef.current) return;
  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  debounceTimerRef.current = setTimeout(() => {
    if (isMountedRef.current) setTokenVersion((prev) => prev + 1);
    debounceTimerRef.current = null;
  }, TOKEN_VERSION_DEBOUNCE_MS);
}, []);
```

### 2. Debounced Version Updates in `use-token-cache.ts`

Added debouncing (50ms) to all `setVersion` calls to batch cache updates:

- Cache hit path in `loadOrCount`
- Worker result path in `loadOrCount`
- `preloadFolder` completion
- `clearHotCache` calls
- `invalidate` calls

This reduces re-render cascades from O(n) individual updates to O(1) batched updates.

### Files Modified

1. `packages/file-explorer-ui/src/use-preview-panel-state.ts`
   - Added `TOKEN_VERSION_DEBOUNCE_MS` constant (100ms)
   - Added `debounceTimerRef` ref for timer tracking
   - Added `handleTokenResolved` debounced callback
   - Added cleanup effect for unmount

2. `packages/token-cache/src/use-token-cache.ts`
   - Added `VERSION_DEBOUNCE_MS` constant (50ms)
   - Added `versionDebounceRef` and `isMountedRef` refs
   - Added `debouncedSetVersion` callback
   - Replaced all direct `setVersion` calls with debounced version
   - Updated dependency arrays accordingly
   - Added cleanup effect for unmount

### Validation Results

- ✅ Lint passes (Biome check)
- ✅ Build passes (both packages)
- ✅ Tests pass (481 tests total: 42 token-cache, 439 file-explorer-ui)

## Remaining Work

The debouncing addresses the re-render cascade problem but other O(n) operations remain:

1. **State serialization** - Still runs `Array.from()` on large Sets on every persist
2. **File filtering** - Still runs synchronous minimatch on entire tree
3. **File node cache building** - Still rebuilds entire cache when tree changes

If the resize issue persists after testing, these additional optimizations should be implemented.
