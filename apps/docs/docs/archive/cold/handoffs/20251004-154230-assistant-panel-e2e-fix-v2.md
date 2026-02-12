---
title: "20251004 154230 Assistant Panel E2e Fix V2"
status: "cold-archive"
date: "2025-10-04"
superseded_by: "none"
---

# Desktop Assistant E2E Fix — 2025-02-15 (Revised)

## Problem Summary
The desktop E2E test `assistant-panel.desktop.test.ts` was failing because the assistant input textarea remained `disabled`. The test timed out when trying to fill the input field.

## Root Cause
**IPC secrets API not mocked in test mode:**

The fundamental issue was that `window.secrets` in Electron is exposed via `contextBridge` and makes IPC calls to the main process. The test was trying to mock `window.secrets` in the renderer, but:

1. `contextBridge.exposeInMainWorld()` creates **frozen** objects that cannot be overridden
2. All calls go through IPC to the main process
3. In test mode, the main process secrets service had no providers configured
4. Therefore, `window.secrets.list()` returned `[]`
5. The `AssistantUiPanelWrapper` component's `useEffect` called `getAvailableProviders()`
6. With no available providers, `isProviderReady = false` → composer disabled

## Why Web Tests Pass
- Web version doesn't use Electron's IPC system
- No `contextBridge` limitations
- Secrets management is different (uses environment variables/config)

## Solution Implemented

### Mock Secrets at the IPC Handler Level
**File:** `apps/desktop/src/ipc-secrets.ts`

Added test mode detection and mock responses in the IPC handlers themselves:

```typescript
function isTestMode(): boolean {
  const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
  const nodeEnv = process.env['NODE_ENV'];
  return (
    process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test'
  );
}

export function registerSecretsIpcHandlers(secrets: SecretsService) {
  // secrets:list handler
  ipcMain.handle('secrets:list', async () => {
    if (isTestMode()) {
      return ['openai'];  // ← Mock response
    }
    return await secrets.listProviders();
  });

  // secrets:get handler
  ipcMain.handle('secrets:get', async (_e: IpcMainInvokeEvent, provider: string) => {
    if (isTestMode() && provider === 'openai') {
      return 'test-api-key-for-e2e-tests';  // ← Mock API key
    }
    const v = await secrets.getKey(provider);
    return v;
  });

  // secrets:save and secrets:delete also mocked for test mode
}
```

### Simplified E2E Test
**File:** `apps/desktop/e2e/assistant-panel.desktop.test.ts`

Removed all renderer-level secrets mocking attempts. Now only:
1. Sets localStorage with selected provider preference
2. Mocks fetch for assistant API calls
3. Relies on `--test-mode` flag to provide mocked secrets via IPC

```typescript
await page.addInitScript(() => {
  // Set localStorage with OpenAI as selected provider
  window.localStorage?.setItem(
    'assistant-preferences.v1',
    JSON.stringify({
      state: {
        selectedProvider: 'openai',
        modelsByProvider: { openai: 'gpt-4o', /* ... */ },
      },
      version: 1,
    })
  );

  // Mock fetch for assistant API responses
  // (secrets.list() now returns ['openai'] automatically via IPC mock)
});
```

## How It Works Now

1. Test launches Electron with `--test-mode` flag
2. IPC handlers detect test mode via `isTestMode()`
3. `secrets:list` IPC call returns `['openai']` automatically
4. `AssistantUiPanelWrapper` component mounts
5. Component's `useEffect` calls `getAvailableProviders()`
6. `getAvailableProviders()` calls `window.secrets.list()` → IPC → returns `['openai']`
7. Component updates `availableProviders = ['openai']`
8. localStorage provides `selectedProvider = 'openai'`
9. `isProviderReady = true` → composer becomes enabled ✓
10. Test can fill input field

## Files Changed

### Main Fix
1. **`apps/desktop/src/ipc-secrets.ts`**
   - Added `isTestMode()` helper function
   - Added test mode branches to all four IPC handlers:
     - `secrets:list` → returns `['openai']`
     - `secrets:get` → returns `'test-api-key-for-e2e-tests'` for OpenAI
     - `secrets:save` → returns success
     - `secrets:delete` → returns success

### Test Simplification
2. **`apps/desktop/e2e/assistant-panel.desktop.test.ts`**
   - Removed all attempts to mock `window.secrets` in renderer
   - Kept localStorage setup for provider preferences
   - Kept fetch mocking for assistant API responses
   - Fixed mock stream format to include finish chunk

### Cleanup
3. **`packages/app-shell/src/stores/assistant-preferences-store.ts`**
   - Removed `refreshAvailableProviders()` method (no longer needed)
   - Removed window exposure of store (no longer needed)

## Additional Fix: Mock Stream Format
The mock assistant response stream was also fixed to match the AI SDK data stream protocol:
- Added text chunk: `0:"Hello from desktop assistant!"`
- Added finish chunk: `d:\{"finishReason":"stop","usage":\{...\}\}`
- Updated headers to include `x-vercel-ai-data-stream: v1`

This prevents the test from hanging while waiting for stream completion.

## Verification
✅ Type-checking passes (desktop main + E2E)
✅ Build succeeds
✅ Solution follows existing pattern (other IPC handlers check `--test-mode`)
✅ No changes to renderer code logic
✅ Test is simpler and more maintainable

## Why This Approach is Correct

1. **Respects Electron Security Model**: `contextBridge` is designed to prevent renderer from modifying IPC APIs
2. **Follows Existing Pattern**: Other IPC handlers (file system) already use `--test-mode` flag
3. **Single Source of Truth**: Mocking happens in one place (main process) not scattered across test files
4. **Maintainable**: Future tests automatically get mocked secrets without additional setup
5. **Type-Safe**: No renderer-level hacks or type assertions needed

## Lessons Learned

- Cannot override `contextBridge.exposeInMainWorld()` objects from renderer
- E2E mocking for Electron apps must happen at the IPC handler level
- Check existing test mode patterns before implementing new mocking strategies
- Renderer-level mocks are only suitable for pure renderer APIs (fetch, localStorage, etc.)
