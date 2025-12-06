# Handoff: Window Resize Layout Failure After Heavy File Processing - UNSOLVED

**Date**: 2025-12-06
**Status**: UNSOLVED - All attempted fixes failed
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
