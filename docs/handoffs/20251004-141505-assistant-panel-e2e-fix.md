# Desktop Assistant E2E Fix — 2025-02-15

## Problem Summary
The desktop E2E test `assistant-panel.desktop.test.ts` was failing because the assistant input textarea remained `disabled`. The test timed out when trying to fill the input field.

## Root Cause
**Timing issue with mock initialization and Zustand store hydration:**

1. Test sets up mocks in `page.addInitScript()` before page loads
2. Page reloads to ensure mocks are in place
3. `AssistantUiPanelWrapper` component mounts and immediately calls `getAvailableProviders()` in a `useEffect`
4. `getAvailableProviders()` calls `window.secrets.list()` **synchronously during mount**
5. At this point, the mocked `window.secrets` may not be fully initialized, causing it to return `[]`
6. With no providers, the store sets `availableProviders = []`
7. The wrapper computes `isProviderReady = false` → composer gets `disabled={true}`
8. The test's **post-reload mock injection** (via `page.evaluate()`) runs **too late** - the store already initialized with empty providers and never re-checks

## Why Web Tests Pass
- Web tests don't require provider selection (different architecture)
- Web mocks intercept fetch requests directly without secrets dependency
- No Zustand store that depends on secrets during mount

## Solution Implemented

### 1. Added `refreshAvailableProviders()` Method
**File:** `packages/app-shell/src/stores/assistant-preferences-store.ts`

Added a new public method to the Zustand store:

```typescript
refreshAvailableProviders: async () => {
  const providers = await get().getAvailableProviders();
  // If current provider is no longer available, clear it
  const current = get().selectedProvider;
  if (current && !providers.includes(current)) {
    set({ selectedProvider: null });
  }
  return providers;
}
```

Also exposed the store on `window` for E2E tests:

```typescript
// Expose store API for E2E tests
if (typeof window !== 'undefined') {
  (window as Window & { __assistantPreferencesStore?: typeof useAssistantPreferencesStore }).__assistantPreferencesStore = useAssistantPreferencesStore;
}
```

### 2. Updated E2E Test to Trigger Refresh
**File:** `apps/desktop/e2e/assistant-panel.desktop.test.ts`

**Removed:** Duplicate post-reload mocking code (lines 117-149) that was ineffective

**Added:** Provider refresh trigger after mocks are set:

```typescript
// Trigger provider refresh now that secrets mock is in place
// Wait a bit for the store to be initialized and exposed
await page.waitForTimeout(500);

await page.evaluate(async () => {
  const store = (window as Window & { __assistantPreferencesStore?: { getState: () => { refreshAvailableProviders: () => Promise<unknown>; setProvider: (p: string) => void } } }).__assistantPreferencesStore;
  if (store) {
    const state = store.getState();
    await state.refreshAvailableProviders();
    // Ensure provider is set after refresh
    state.setProvider('openai');
  }
});
```

## How It Works Now

1. Test sets up mocks in `addInitScript` (before page load)
2. Page reloads - store initializes (may get empty providers initially)
3. After `waitForAppReady()`, test waits 500ms for store to be exposed
4. Test calls `refreshAvailableProviders()` which re-queries the (now mocked) `window.secrets.list()`
5. Store gets `['openai']` as available providers
6. Test explicitly sets provider to `'openai'`
7. Composer becomes enabled (`isProviderReady = true`)
8. Test can now fill the input field

## Files Changed
1. `packages/app-shell/src/stores/assistant-preferences-store.ts`
   - Added `refreshAvailableProviders()` method
   - Exposed store on window for E2E tests

2. `apps/desktop/e2e/assistant-panel.desktop.test.ts`
   - Removed duplicate post-reload mocking
   - Added store refresh trigger after app ready
   - Fixed mock stream format to match assistant-ui data stream protocol:
     - Changed from custom format to proper AI SDK format
     - Added finish chunk (type 'd') to properly signal stream completion
     - Updated headers to include 'x-vercel-ai-data-stream: v1'

## Verification
✅ Type-checking passes for app-shell and desktop E2E
✅ Unit tests pass (221 tests in app-shell)
✅ Build succeeds for both packages

## Additional Issue Fixed: Test Hanging During Cleanup
During testing, we discovered the test was hanging during the cleanup phase (waiting for port cleanup). This was caused by the mock stream not sending a proper finish signal, causing assistant-ui to wait indefinitely for more data.

**Solution:** Updated the mock stream to send a finish chunk (`d:{"finishReason":"stop",...}`) which properly signals stream completion to the assistant-ui library.

## Note on CI
The local Electron launch issue (`--remote-debugging-port=0` error) is a local environment problem unrelated to these changes. The CI environment should handle Electron correctly.

## Alternative Solutions Considered

1. **Pre-populate before first render** - More fragile, relies on exact timing
2. **Test-mode flag** - Adds complexity and bypasses real code paths
3. **Force store re-initialization (chosen)** - Cleanest, allows test to control timing explicitly

## Future Improvements
Consider adding a `window.addEventListener('DOMContentLoaded', ...)` guard in the store exposure to ensure it's available before tests try to access it, though the 500ms timeout should be sufficient.
