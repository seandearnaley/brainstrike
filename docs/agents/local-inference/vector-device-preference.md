# Vector device preference: one canonical record (BST-1380) — evidence

Supports `docs/agents/local-inference.md` § "Vector device preference". Read
before changing how the hidden host resolves `devicePref`, the scoped
`vector-preferences` capability, or the store's hydration assertion. The
BST-1235 incident below is why the store fails closed instead of falling back
to browser storage.

## Original text

Vector device preference is ONE canonical record (BST-1380):
- The host resolves `devicePref`/`devicePrefConfigured` from the SAME
  `vector-preferences.v1` record the visible UI writes. The visible UI reaches it
  through `electronAPI.storage`; the hidden host reaches it through the scoped
  `electronAPI.vectorPreferences` capability (`vector-preferences:read` /
  `:write` / `:clear`), authorized to the `embedding-host` role only. Those
  channels accept NO key — `apps/desktop/src/platform/vector-preferences-storage-key.ts`
  pins it in main — so a hidden host can neither enumerate keys nor address
  another persisted store.
- `packages/app-state/src/stores/vector-preferences-store.ts` must NOT fall back
  to browser storage when an Electron renderer exposes neither capability; it
  throws. Zustand's persist middleware swallows storage rejections and resolves
  `rehydrate()` anyway, so `ensureVectorPreferencesHydrated` asserts the
  capability itself — a swallowed read would otherwise present as
  "unconfigured, use WebGPU".
- History: BST-1235 moved hidden hosts onto the narrow manifest, which silently
  dropped `electronAPI.storage`. The host then read an empty per-host
  localStorage, saw `devicePrefConfigured: false`, ran auto-detection, and
  fail-closed on every machine without a WebGPU adapter — ignoring the user's
  explicit setting. Do not "fix" a recurrence by relaxing the E2E assertion or
  by re-exposing the full storage bridge. Paired tests:
  `vector-preferences-store.hidden-host.test.ts`,
  `hidden-preload-runtime.test.ts`, `hidden-preload-contract.test.ts`,
  `storage-preferences-ipc.test.ts`,
  `vector-preferences-storage-key-contract.test.ts`.
