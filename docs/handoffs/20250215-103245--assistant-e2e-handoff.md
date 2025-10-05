# Desktop Assistant E2E Handoff — 2025-02-15

## Current Status
- Desktop multi-provider work landed: provider selection now mandatory everywhere (no OpenAI fallback).
- Unit, integration, and web Vitest suites pass. Desktop unit/type-check pass. Desktop Playwright functional suite passes.
- One desktop E2E scenario still red in CI: `e2e/assistant-panel.desktop.test.ts` (“send message and see streamed response in right panel”). The run times out trying to `fill()` the assistant textarea because the element remains `disabled`.

## Key Changes in Scope
- `assistant-server.ts` now rejects requests without `provider` and only reports `enabled` if secrets/environment supply a key. It logs but no longer throws when secrets storage is unreachable.
- `ipc-agent.ts` mirrors that provider enforcement.
- React assistant panel integrates multi-provider store; composer disables until provider + model selected.
- Desktop E2Es inject mocks to keep the assistant enabled without user interaction (seeding localStorage + secrets, intercepting `/assistant/status` & `/assistant` requests).

## What We Tried
1. **Agent IPC mock update** — Added `{ provider: 'openai' }` when calling `window.agent.chat` so IPC path keeps working. Confirmed passing (`agent-ipc.test.ts`).
2. **Assist panel mocks (pre-reload)** — `page.addInitScript()` seeds `localStorage` with `assistant-preferences.v1` (`selectedProvider: 'openai'`, default models) and replaces `window.fetch` for status/assistant endpoints. Also attempted to stub `window.secrets` with test key.
3. **Assist panel mocks (post-reload)** — After `waitForAppReady` we re-applied the same seeding/mocking. Initially we reassigned `window.secrets = {...}`; later switched to mutating the existing object in case `contextBridge` exposes a frozen reference.
4. **Assistant server fallback** — Relaxed secrets inspection error handling so status endpoint still reports `enabled` even if the store cannot be read (just logs the error). Hypothesis was that CI contextBridge might reject our mocks due to secrets errors.
5. **Web build/type checks** — Added TypeScript project references/aliases for `@brainstrike/agent/client` to ensure front-end builds succeed. (Not directly related but now in tree.)

## Observations & Hypotheses
- CI traces (see `blob-report/assistant-panel.desktop-*.zip`) show the textarea stays `disabled` despite being rendered. The fetch override is working locally, so likely status endpoint returns `{ enabled: false }` before our mocks take effect.
- The Zustand store (`assistant-preferences-store.ts`) calls `getAvailableProviders()` in a `useEffect` on mount. That function hits `window.secrets.list()` immediately. If our override runs too late (after the effect runs) the first call returns `[]`, causing the store to remain provider-less even after we mutate later.
- When we mutate `window.secrets` post-mount, Zustand never re-requests provider list, so composer remains disabled. Need to confirm by logging from preload/renderer in CI.
- Another angle: contextBridge exposes methods with descriptors `{ enumerable: true, configurable: false }`. Direct property reassignment may fail silently. We may need to `Object.assign(window.secrets, { list: ... })` or use `Reflect.set` to override.
- There is still the possibility the panel is reading secrets before the page reload finishes; maybe we flush mocks too late. Running `page.evaluate` after reload may still occur after the assistant panel already initialized.

## Suggested Next Steps / Questions for New Dev
1. **Confirm timing:** Add temporary logging inside `assistant-preferences-store` (or instrument via `page.exposeFunction`) to see what `getAvailableProviders()` returns during the test. Alternatively, wait for a known signal (`window.__assistantStoreReady`) before enabling composer.
2. **Override earlier:** Try injecting the secrets override via `page.addInitScript` *before* the reload and stop modifying after reload; verify the contextBridge object retains modifications. If immutable, consider using Electron’s `contextBridge.exposeInMainWorld` to add a shim from preload (feature-flag for test mode?).
3. **Force provider via query param/env:** The store reads from localStorage and secrets. Perhaps short-circuit `useAssistantPreferencesStore` in test mode (env flag) to default to `'openai'` without secrets.
4. **Network check:** Validate from the trace whether `/assistant/status` hits our override (should be 200 with `{ enabled: true }`). If not, the fetch patch may need to run sooner (maybe we reload too quickly after injecting).
5. **Fail-fast guard:** As a stopgap, the test could manually dispatch the Zustand `setProvider('openai')` via `page.evaluate`. That would bypass secrets entirely; if that works, we know the issue is on the secrets/localStorage path.

## Repro Commands
```sh
# Run the failing suite locally
pnpm --filter @brainstrike/desktop test:e2e -- --grep "Assistant panel"

# Type-check E2E configs
pnpm --filter @brainstrike/desktop type-check:e2e
```

## Files of Interest
- `apps/desktop/src/assistant-server.ts`
- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- `packages/app-shell/src/stores/assistant-preferences-store.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/e2e/assistant-panel.desktop.test.ts`
- `apps/desktop/e2e/mcp-filesystem.desktop.test.ts`

## Open Questions
- Is there a reliable hook to inject provider defaults before the renderer store hydrates? (e.g., gating on `window.addEventListener('DOMContentLoaded', ...)` inside the test fixture.)
- Should the desktop app expose a “test mode” IPC endpoint to save provider prefs directly, avoiding renderer hacks?
- Do we want the assistant server to treat the E2E env key (`test-api-key-for-e2e-tests`) as a valid secret automatically?

Let me know if any additional context/screenshots are needed. Happy to jump on a call if desired.
