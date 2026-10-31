# @brainstrike/storage

Two string stores, separate from the host StateStore, conversation log and derived index.

## Durable renderer stores

`persistDurable(key, creator, options)` ([`durable-store.ts`](src/durable-store.ts)) is the one way a renderer store keeps state across reloads. It is zustand's [`persist`](https://zustand.docs.pmnd.rs/middlewares/persist) over this renderer's `localStorage` as JSON.

```ts
export const useExampleStore = create<ExampleState>()(
  persistDurable('brainstrike:example.v1', (set) => ({ ... }), { partialize, version: 1 })
);
```

- Keys are `DurableKey`s, under `DURABLE_KEY_PREFIX` (`brainstrike:`). Tests and E2E seeds read and write the same key.
- `name` and `storage` are the factory's; every other `persist` option passes through. Validate saved state in `merge` or `migrate`.
- A saved value that is not JSON reads as nothing saved: the store hydrates on its defaults, the discard is logged and reported to `onUnreadable`, and the next change overwrites it. (zustand's own read rejects and leaves `hasHydrated()` false.)
- Writes are synchronous: a change is saved when `set` returns. A store owns no fallback, write-behind or reset code.
- Main's Factory Reset clears the whole origin's storage (`clearStorageData`, ADR-0015), so every store joins reset by construction.
- Tests get a clean store from `@brainstrike/test-utils/zustand-store-reset` (zustand's testing guide).
- Preferences are not a secret store; credentials use the credential owner.

## Main's ledgers

`ElectronStorageAdapter` (from `@brainstrike/storage/electron`, Electron main only) implements `StorageAdapter` ([`types.ts`](src/types.ts)). It holds Main's workspace-root ledgers (`rootsList`, `recentRootsList`, `lastFolderPath`); the renderer has no IPC path to it.

- Optional filename, default `electron-storage.json` under `app.getPath('userData')`.
- JSON files with ordered temp-file/rename writes.
- Invalid paths and corrupt or unreadable storage reject visibly.
