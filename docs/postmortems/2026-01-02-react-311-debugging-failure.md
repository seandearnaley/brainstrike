# Postmortem: React Error #311 Debugging Failure

**Date:** 2026-01-02
**Status:** UNRESOLVED
**Severity:** Critical - Blocks SelectionModeBadge feature in Electron production builds

## Summary

Failed to resolve React internal error #311 ("Should have a queue. You are likely calling Hooks conditionally") in the Electron desktop production build. The error occurs when the `SelectionModeBadge` component is rendered.

## Timeline

1. **Initial State**: `SelectionModeBadge` and `SelectionRulesEditor` components were integrated into `file-explorer-left-panel.tsx`
2. **Error Discovery**: React #311 error appeared only in Electron production builds, not in web builds
3. **Debugging Session**: ~2 hours of systematic isolation testing

## What Was Tried

### Attempt 1: Add `as const` to selectors
- **Hypothesis**: Array destructuring without `as const` causes type instability
- **Result**: FAILED - `as const` is TypeScript-only, doesn't affect runtime

### Attempt 2: Separate selectors instead of array destructuring
- **Hypothesis**: Array selector pattern causes issues with useSyncExternalStore
- **Result**: FAILED - Same error

### Attempt 3: Disable all new components
- **Result**: Error disappeared - confirmed new code is the cause

### Attempt 4: Systematic re-enabling
- **Finding**: `SelectionRulesEditor` alone = NO ERROR
- **Finding**: `SelectionModeBadge` alone = ERROR
- **Conclusion**: Bug is in `SelectionModeBadge` specifically

### Attempt 5: Add `show` prop for conditional rendering
- **Hypothesis**: Conditional mounting/unmounting causes hook issues
- **Result**: FAILED - Error persists even with always-render pattern

### Attempt 6: Remove store access entirely
- **Result**: NO ERROR - confirmed store access is the cause

### Attempt 7: Add back store context only (no selectors)
- **Result**: NO ERROR

### Attempt 8: Add single selector (selectionModel)
- **Result**: NO ERROR

### Attempt 9: Add all selectors without using them
- **Result**: NO ERROR

### Attempt 10: Derive values from selectionModel
- **Finding**: `selectionModel.mode === 'rules'` = NO ERROR
- **Finding**: `selectionModel.materializedPaths?.size` = ERROR
- **Conclusion**: Accessing `materializedPaths` (a Set object) triggers the error

### Attempt 11: Select materializedPaths directly
- **Hypothesis**: Selecting the nested property directly avoids the issue
- **Result**: FAILED

### Attempt 12: Select only primitives (compute in selector)
- **Change**: `store((s) => s.selectionModel.materializedPaths?.size ?? 0)`
- **Result**: FAILED

## Root Cause Analysis

The error is triggered when accessing `selectionModel.materializedPaths` in any form within `SelectionModeBadge`. This is a `Set<string>` object stored in the Zustand store.

**Possible causes (not yet confirmed):**
1. React Compiler (`babel-plugin-react-compiler`) miscompiles Set access in production
2. Zustand's `useSyncExternalStore` has issues with Set objects in Electron's V8
3. Some interaction between memo(), Zustand selectors, and Set objects
4. Electron's production bundling (Vite) handles Set objects differently

**Why it works elsewhere:**
- `SelectionRulesEditor` uses the same store but doesn't access `materializedPaths`
- Web builds work fine (different bundling/runtime)
- Other components access the store without issues

## What Was NOT Tried

1. Removing React Compiler from the Electron build
2. Using Zustand's `shallow` equality for selectors
3. Converting `materializedPaths` from Set to Array in the store
4. Using `useStore` with manual subscription instead of hook selectors
5. Checking if the issue is specific to the `memo()` wrapper
6. Testing with Electron dev mode instead of production
7. Comparing Vite configs between web and desktop builds

## Lessons Learned

1. **React #311 is an internal scheduler error** - it indicates React's hook queue is corrupted, not a user-level conditional hook call
2. **Electron production builds can behave differently** from web builds even with identical source code
3. **Set objects in Zustand state may have special handling requirements** in certain environments
4. **Systematic isolation is effective** but time-consuming - should have jumped to removing store access sooner

## Recommended Next Steps

1. **Immediate workaround**: Remove `materializedPaths` access from `SelectionModeBadge`, show count from parent component via props
2. **Investigation**: Compare compiled output between web and desktop builds
3. **Investigation**: Test with React Compiler disabled in desktop build
4. **Investigation**: Check if Zustand's `useShallow` hook resolves the issue
5. **Long-term**: Consider using plain arrays instead of Sets in Zustand state for cross-platform compatibility

## Files Affected

- `/packages/file-explorer-ui/src/selection-mode-badge.tsx` - Component with the bug
- `/packages/file-explorer-ui/src/file-explorer-left-panel.tsx` - Parent component
- `/packages/file-explorer-ui/src/hooks/use-rule-materialization.ts` - Currently disabled

## Current State of Code

`SelectionModeBadge` currently has selectors that compute primitives directly:
```typescript
const isRulesMode = store((s) => s.selectionModel.mode === 'rules');
const materializedCount = store((s) => s.selectionModel.materializedPaths?.size ?? 0);
const hasRules = store((s) => !!s.selectionModel.ruleSetJson);
```

This still causes the error. The component is effectively broken in Electron production builds.

---

**Author:** Claude Code
**Review Status:** Unreviewed - debugging session ended in failure
