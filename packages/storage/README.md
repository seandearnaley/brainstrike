# @brainstrike/storage

String key/value adapters for browser preferences, Electron preference files and
explicit in-memory tests. This package is separate from the canonical host
StateStore, conversation log and derived index.

## Actual API

All asynchronous adapters implement `StorageAdapter` in
[`types.ts`](src/types.ts): `getItem`, `setItem`, `removeItem`, `getAllKeys` and
`clear`. Values are strings; a missing key returns `null`. Serialize and validate
structured values at their owning boundary.

```ts
import { createMemoryStorageAdapter } from '@brainstrike/storage';

const storage = createMemoryStorageAdapter();
await storage.setItem('theme', 'dark');
const theme = await storage.getItem('theme');
await storage.removeItem('theme');
```

## Choose the adapter explicitly

- `createBrowserStorageAdapter()` / `WebStorageAdapter` wrap browser
  `localStorage`. The async interface does not make underlying browser I/O
  nonblocking. `WebStorageAdapter` also accepts an injected `Storage` instance.
- `createMemoryStorageAdapter()` / `MemoryStorageAdapter` are explicitly
  ephemeral. They are not a persistence fallback.
- `createStorageAdapter(platform)` takes an explicit platform. It accepts web,
  refuses Electron through this entry and rejects unknown platforms. It neither
  auto-detects the platform nor defaults to memory.
- Electron main imports `ElectronStorageAdapter` from
  `@brainstrike/storage/electron`. Its constructor takes an optional filename,
  defaulting to `electron-storage.json` under `app.getPath('userData')`.
  It uses JSON files and ordered temporary-file/rename writes, not `electron-store`.
  Invalid paths or corrupt/unreadable existing storage reject visibly. The root
  package entry does not export this Node-only adapter.

## Other persistence helpers

[`safe-storage.ts`](src/safe-storage.ts) exposes a separate synchronous JSON
storage interface and persistence-issue reporting; it is not the asynchronous
adapter API. Read its failure policy before using it for durable state.
[`debounced-storage.ts`](src/debounced-storage.ts) buffers writes by key and
provides `flush()`; read-after-write sees pending values and removal cancels its
pending write. A queued save is not proof that persistence completed.

Preferences are not a secret store. Provider credentials use the existing
credential owner. New durable state participates in the existing
[reset lifecycle](../../docs/agents/platform-contracts.md).

## Development

Declare `"@brainstrike/storage": "workspace:*"` in a consuming workspace.
[`package.json`](package.json) owns exports and scripts. From this package use
`pnpm build`, `pnpm type-check`, `pnpm test` or `pnpm test:browser` as appropriate.
**CI is disabled due to cost; validation must run locally.** See
[validation guidance](../../docs/agents/ci-quality.md).
