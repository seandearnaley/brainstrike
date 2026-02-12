---
title: "BST-300 Restore Access Debugging"
sidebar_position: 5
---

# BST-300: Restore Access Modal - Debugging Report

## Problem Summary

The "Restore Access" modal gets stuck on "Restoring..." and the browser permission dialog never appears. This happens in Chrome when attempting to restore access to a previously-opened folder via IndexedDB-persisted `FileSystemDirectoryHandle`.

## Root Cause Analysis

### The Core Issue: Chrome's User Gesture Requirement

Chrome's File System Access API has a strict requirement: **`requestPermission()` must be called within the same synchronous call stack as a user gesture (click)**.

When the user clicks "Restore Access":
1. The click event fires
2. Code awaits through multiple async operations
3. By the time `requestPermission()` is called, Chrome has "lost" the user gesture context
4. Chrome silently blocks the permission dialog (no error thrown)
5. The promise never resolves, causing the infinite "Restoring..." state

### Evidence from Logs

```
restoreLastRootHandle: requesting permission from user
requestPermissionWithTimeout: starting
requestPermissionWithTimeout: calling handle.requestPermission()
[10 seconds pass]
requestPermissionWithTimeout: timeout triggered after {"elapsedMs":10000}
```

The `requestPermission()` call never completed - it didn't show a dialog, didn't grant, didn't deny. Chrome just blocked it silently.

## Attempted Fixes

### Attempt 1: Timeout Protection
- Added 60s (later 10s) timeout around `requestPermission()`
- **Result**: Timeout worked but didn't fix the root cause - permission dialog still never appeared

### Attempt 2: Dual Source of Truth Fix
- Added `setAccessLoading` to prevent stale state clearing during restore
- **Result**: Didn't address the gesture context issue

### Attempt 3: Synchronous Permission Request (Latest)
- Created `getLastRootHandleForRestore()` to return raw handle WITHOUT requesting permission
- Store raw `FileSystemDirectoryHandle` in React state during initialization
- Call `requestPermission()` IMMEDIATELY in click handler before any awaits
- **Result**: Still not working - likely still losing gesture context somewhere

## Current Architecture

### Files Involved

1. **`packages/file-system/src/adapters/web-handle-cache.ts`**
   - `WebHandleCache` class manages IndexedDB persistence
   - `getLastRootHandleForRestore()` - queries permission state, returns raw handle
   - `markHandleRestored()` - updates timestamp after successful restore
   - `restoreLastRootHandle()` - legacy method that requests permission internally

2. **`packages/file-explorer-hooks/src/use-restore-access.ts`**
   - `useRestoreAccess()` hook manages restore UI state
   - `PendingRestoreState` includes `rawHandle` and `permissionState`
   - `beginRestore()` should call `requestPermission()` synchronously

3. **`packages/file-explorer-ui/src/components/restore-access-modal.tsx`**
   - Modal component with "Restore Access" button
   - `onRestore` callback triggers `beginRestore()`

4. **`packages/file-explorer-ui/src/components/file-explorer-toolbar.tsx`**
   - Renders `RestoreAccessModal`
   - Wires up the restore flow

### Data Flow

```
User clicks "Restore Access"
    ↓
RestoreAccessModal.onRestore()
    ↓
FileExplorerToolbar handler
    ↓
beginRestore() in useRestoreAccess
    ↓
rawHandle.requestPermission({ mode: 'read' })  ← Should happen HERE, synchronously
    ↓
[Chrome blocks because gesture context lost]
```

## Why It's Still Failing

Even with the "synchronous" fix, there may be additional async hops:

1. **React's event batching**: React 18+ batches state updates, which may introduce microtask delays
2. **The modal's onClick**: May go through React's synthetic event system
3. **The callback chain**: `onRestore` → parent handler → hook method adds call stack depth
4. **State setter calls**: Even synchronous-looking code may trigger React re-renders

### Potential Culprits

```typescript
// In RestoreAccessModal
<Button onClick={onRestore}>  // React synthetic event
  Restore Access
</Button>

// In FileExplorerToolbar
const handleRestore = async () => {  // async function!
  setIsRestoring(true);  // State update - may batch
  const handle = await beginRestore();  // await!
  // ...
}
```

The `async` keyword on `handleRestore` and the `await` before getting the handle means the permission request is NOT in the synchronous click handler chain.

## Recommendations

### Option 1: Move Permission Request to Raw onClick

The permission request MUST happen directly in the button's onClick, with NO async/await before it:

```typescript
// In the modal or toolbar component
const handleRestoreClick = () => {
  // IMMEDIATELY request permission - no awaits before this
  if (pendingRestore?.rawHandle?.requestPermission) {
    pendingRestore.rawHandle.requestPermission({ mode: 'read' })
      .then((result) => {
        if (result === 'granted') {
          // Now do the async stuff
          completeRestore();
        }
      });
  }
};
```

### Option 2: Use a Hidden File Input Pattern (UNTESTED)

Some apps reportedly work around this by using `<input type="file">` with `webkitdirectory`:

```typescript
<input
  type="file"
  webkitdirectory
  style={{ display: 'none' }}
  onChange={(e) => handleDirectorySelected(e.target.files)}
/>
```

**Note**: This approach has NOT been tested in this codebase. It may have its own issues.

### Option 3: Re-request via showDirectoryPicker (UNTESTED)

Instead of restoring the old handle, prompt the user to re-select the same folder:

```typescript
const handleRestore = () => {
  window.showDirectoryPicker().then((handle) => {
    setRootDirectoryHandle(toDirectoryHandle(handle));
  });
};
```

**Note**: This would require user to navigate to the folder again. Has NOT been tested - may also fail if the same async/React patterns interfere.

### Option 4: Investigate React 19 Specifics

React 19 changed how events and state updates batch. The project uses React 19 - there may be specific patterns needed:

- Use `flushSync` to force synchronous state updates
- Use `useTransition` carefully to avoid deferring critical code
- Check if `startTransition` is wrapping any of this code

## Testing Suggestions

### Manual Testing Steps

1. Open DevTools Network tab
2. Clear IndexedDB: `indexedDB.deleteDatabase('brainstrike-file-handles')`
3. Reload page
4. Select a folder via toolbar
5. Reload page
6. Watch console for restore-related logs
7. Click "Restore Access" and watch for:
   - Permission dialog appearance
   - Any console errors
   - Network requests

### Debug Logging

Add this to the button onClick to verify gesture context:

```typescript
console.log('Click event:', {
  isTrusted: event.isTrusted,
  type: event.type,
  timestamp: Date.now(),
});
```

Chrome requires `event.isTrusted === true` for permission requests.

## Files Changed in This Debugging Session

| File | Changes |
|------|---------|
| `packages/file-system/src/adapters/web-handle-cache.ts` | Added `getLastRootHandleForRestore()`, `markHandleRestored()`, timeout wrapper |
| `packages/file-explorer-hooks/src/use-restore-access.ts` | Complete rewrite to store raw handle and request permission "synchronously" |
| `packages/file-explorer-hooks/src/__tests__/use-restore-access.test.tsx` | Updated tests for new API |
| `packages/file-system/src/__tests__/web-adapter.test.ts` | Added mocks for new methods |
| `packages/file-explorer-hooks/src/use-file-system.ts` | Added `setAccessLoading` |
| `packages/file-explorer-ui/src/use-file-explorer-context.ts` | Exposed `setAccessLoading` |

## References

- [File System Access API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- [Chrome's User Activation Requirements](https://developer.chrome.com/blog/user-activation/)
- [Transient Activation in Web APIs](https://html.spec.whatwg.org/multipage/interaction.html#transient-activation)

## Key Insight

The File System Access API's `requestPermission()` is extremely sensitive to the call stack. Even seemingly synchronous code paths can lose the gesture context through:

1. Promise microtask boundaries
2. React's batched updates
3. Async function declarations (even without await before the call)
4. setTimeout/setImmediate
5. Any other mechanism that defers execution to a later tick

The theoretically correct pattern is:

```typescript
button.addEventListener('click', () => {
  // requestPermission() should work here
  handle.requestPermission({ mode: 'read' });
});
```

**However**: We have not successfully implemented this in practice. React's component model and hooks abstract away the actual DOM click handler through multiple layers, and every attempt to call `requestPermission()` "synchronously" has still failed.

## Status: RESOLVED ✅

**The fix has been implemented** in `file-explorer-left-panel.tsx`.

### The Solution

The key insight was that **the `requestPermission()` call must be the FIRST thing executed** in the click handler, with zero async operations or React state updates before it. Chrome's transient activation expires after ~5 seconds but more importantly, any async boundary (await, Promise.then from prior code, or React's batched state updates) can break the gesture context.

### Implementation

The fix was applied in `packages/file-explorer-ui/src/file-explorer-left-panel.tsx`. The key changes:

1. **Changed from async/await to .then() chains**: The handler is now a regular function, not an async function
2. **Call requestPermission() FIRST**: Before any state updates or other operations
3. **Use the raw handle from pendingRestore state**: Already loaded during initialization

```typescript
onRestore={() => {
  // CRITICAL: Chrome requires requestPermission() to be called synchronously
  // within the user gesture context. Any await/async before this call will
  // cause Chrome to silently block the permission dialog.
  const rawHandle = pendingRestore?.rawHandle;

  // SYNCHRONOUS permission request - must happen BEFORE any await/setState
  rawHandle
    .requestPermission({ mode: 'read' })
    .then((permissionResult) => {
      if (permissionResult === 'granted') {
        // Now we can safely do async work after permission is granted
        setAccessLoading(true);
        setIsRestoring(true);
        // ... rest of restore logic
      }
    });
}}
```

### Why Previous Attempts Failed

1. **Attempt 1 (async/await in handler)**: The `async () => {}` function declaration itself doesn't break the gesture, but any `await` before `requestPermission()` does.

2. **Attempt 2 (state updates before request)**: Even synchronous-looking `setIsRestoring(true)` calls can cause React to batch updates and defer execution.

3. **Attempt 3 (beginRestore calling requestPermission)**: Having the permission request inside a `useCallback` hook that's called from the click handler adds extra call stack frames that React's batching may use as boundaries.

### The Working Pattern

1. Get the raw `FileSystemDirectoryHandle` from React state (stored during initialization via `pendingRestore.rawHandle`)
2. Call `requestPermission()` **immediately** in the onClick handler - no awaits, no state updates before it
3. Use `.then()` instead of `await` to avoid marking the handler as async
4. Do all state updates and other async work **after** the permission promise resolves

### References

- [Chrome User Activation Blog](https://developer.chrome.com/blog/user-activation)
- [MDN Transient Activation](https://developer.mozilla.org/en-US/docs/Glossary/Transient_activation)
- [React flushSync docs](https://react.dev/reference/react-dom/flushSync) (considered but not needed)

---

## Issue 2: Expanded Directories Not Restoring After Folder Restore

### Problem

After successfully restoring folder access via the "Restore Access" modal, the folder appeared but expanded directories were not restored. Users reported: "The folder reappeared, but the expansion didn't."

### Root Cause

**Zustand store hydration timing issue.** When `setCurrentFolderId` was called after permission was granted, the Zustand persist middleware hadn't finished hydrating `folderStates` from localStorage yet. This caused `setCurrentFolderId` to:

1. Look up `folderStates[folderId]`
2. Find nothing (because hydration was incomplete)
3. Create a new empty folder state instead of restoring the existing one

### The Fix

Wait for Zustand store hydration before setting the folder ID:

```typescript
// In file-explorer-left-panel.tsx
const completeRestore = (handle: FileSystemDirectoryHandle) => {
  // Wait for Zustand store hydration before setting folder ID
  const persistApi = store as unknown as {
    persist?: {
      hasHydrated?: () => boolean;
      onFinishHydration?: (cb: () => void) => () => void;
    };
  };

  const doRestore = () => {
    const directoryHandle = {
      path: handle.name,
      name: handle.name,
      kind: 'directory' as const,
      platform: 'web' as const,
      _internal: handle,
    };
    setRootDirectoryHandle(directoryHandle);
    // Note: setRootDirectoryHandle already calls setCurrentFolderId internally
    beginRestore().catch(() => {}).finally(() => {
      setIsRestoring(false);
      setAccessLoading(false);
    });
  };

  // Check if store has hydrated
  if (persistApi.persist?.hasHydrated?.()) {
    doRestore();
  } else if (persistApi.persist?.onFinishHydration) {
    const unsub = persistApi.persist.onFinishHydration(() => {
      unsub();
      doRestore();
    });
  } else {
    doRestore(); // No persist API available
  }
};
```

### Key Insight

The Zustand `persist` middleware hydrates asynchronously from storage. Code that depends on persisted state (like `folderStates`) must either:

1. Wait for `persist.hasHydrated()` to return `true`, or
2. Subscribe to `persist.onFinishHydration()` callback

### Debug Logging Added

The following debug logs were added to trace folder state restoration (can be removed after verification):

- `[setCurrentFolderId] called` - Shows folder ID and whether state exists
- `[setCurrentFolderId] branch check` - Shows which code path will execute
- `[setCurrentFolderId] RESTORING folder state` - Confirms state restoration
- `[onRestore] completeRestore called, checking hydration` - Traces hydration wait
- `[onRestore] Store already hydrated` / `Waiting for store hydration...` - Shows hydration status
