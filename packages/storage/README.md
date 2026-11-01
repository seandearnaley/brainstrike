# @brainstrike/storage

String key/value adapters for browser `localStorage`, Main's workspace-root ledgers and in-memory tests. Separate from the host StateStore, conversation log and derived index.

## API

Every async adapter implements `StorageAdapter` ([`types.ts`](src/types.ts)): `getItem`, `setItem`, `removeItem`, `getAllKeys`, `clear`. Values are strings and a missing key returns `null`; serialize and validate structured values at their owning boundary.

```ts
import { createMemoryStorageAdapter } from '@brainstrike/storage';

const storage = createMemoryStorageAdapter();
await storage.setItem('theme', 'dark');
```

## Adapters

- `createBrowserStorageAdapter()` / `WebStorageAdapter`: browser `localStorage` (or an injected `Storage`). The async interface doesn't make the underlying I/O nonblocking.
- `createMemoryStorageAdapter()` / `MemoryStorageAdapter`: explicitly ephemeral; never a persistence fallback.
- `ElectronStorageAdapter` (from `@brainstrike/storage/electron`, Electron main only). It holds Main's workspace-root ledgers (`rootsList`, `recentRootsList`, `lastFolderPath`); the renderer has no IPC path to it. Renderer-only preferences use zustand `persist` on `localStorage`.
  - Optional filename, default `electron-storage.json` under `app.getPath('userData')`.
  - JSON files with ordered temp-file/rename writes.
  - Invalid paths and corrupt or unreadable storage reject visibly.

## Other helpers

- [`safe-storage.ts`](src/safe-storage.ts): a separate synchronous JSON storage interface with persistence-issue reporting. Read its failure policy before using it for durable state.
- [`write-behind-writer.ts`](src/write-behind-writer.ts): the one renderer write-behind writer.
  - Buffers writes per key for `delayMs`; reads see pending values, and a removal cancels the pending write.
  - `flush()` resolves only when nothing is buffered or in flight, including values buffered while it waits.
  - `flush()` rejects while any key's newest write was refused, until a newer write of that key lands.
  - It owns no unload listener; document unload joins the flush through `@brainstrike/app-state/renderer-close`.
  - A queued save is not proof of persistence; a resolved `flush()` is.
- Preferences are not a secret store; credentials use the credential owner. New durable state joins the [reset lifecycle](../../docs/agents/platform-contracts.md).
