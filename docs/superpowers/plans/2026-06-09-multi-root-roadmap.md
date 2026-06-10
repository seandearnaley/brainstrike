# Multi-Root Support — Roadmap & Locked Decisions

**Date:** 2026-06-09
**Status:** Phase 1 planned (see `2026-06-09-multi-root-phase-1-db-foundation.md`); later phases get their own plan as each lands.

## Locked product decisions

1. **Collections span multiple roots (n:m); each file belongs to exactly one root.** A `file_records` row has exactly one `root_id`; an embedding set may contain files from many roots.
2. **VS Code-style forest UI** in the file explorer (multiple top-level root nodes in one tree), not tabs.
3. **Web grants are read-only** (`mode: 'read'`). Write-back/editing is a possible future feature, not in scope.
4. **PWA install prompt** added to web onboarding (installed PWAs get persistent FSA grants by default — no re-grant prompt).
5. **No silent fallback tiers.** On Safari/Firefox (no File System Access API), roots are explicit read-only *snapshots* imported into OPFS; the UI says so.

## Platform facts the design rests on (verified June 2026)

- File System Access API is Chromium-only and will stay that way (Mozilla negative, WebKit oppose).
- Chrome 122+ persistent permissions: "Allow on every visit" grants survive restarts; **one prompt re-grants every stored handle for the origin**; installed PWAs persist by default.
- `FileSystemObserver` shipped Chrome 133 (desktop, experimental) — feature-detect for live re-index; rescan is the fallback.
- Storing `FileSystemDirectoryHandle` in IndexedDB remains the canonical persistence mechanism. OPFS is origin-private storage only (now fully writable on Safari 26+) — the snapshot tier's content store.
- Electron renderer FSA support is still rough — desktop stays on real paths via main process. Do not share the FSA code path.

## Core architecture: first-class `Root` entity

```ts
type RootId = string; // uuidv7
type RootDescriptor = { id: RootId; displayName: string; addedAt: number } & (
  | { kind: 'path'; path: string }      // desktop (Electron, Node fs)
  | { kind: 'fsa' }                     // web Chromium; handle lives in IndexedDB keyed by RootId
  | { kind: 'snapshot'; importedAt: number } // web Safari/Firefox; content mirrored into OPFS
);
type RootStatus = 'live' | 'needs-regrant' | 'disconnected' | 'snapshot-stale';
```

Root identity is a generated uuidv7, never a name or path. (The current web cache keys handles by `handle.name` — two roots named `docs` collide. Fixing identity is the keystone.)

## Phase stack (each phase = one PR, lands green and inert until the UI flips on)

1. **DB foundation** *(planned)* — `roots` table, `root_id` FK on `file_records`, backfill from `source_root_path` as `kind: 'legacy'`, new unique index `(embedding_set_id, root_id, path)`. Dual-runner registration (numbered + drizzle custom ledger), both lane registries. Zero behavior change.
2. **Adapter API** — `FileSystemAdapter.addRoot()` / `restoreRoots(): RootDescriptor[]` replacing the singular `requestDirectoryAccess`/`restoreLastFolder`; re-key the web IndexedDB handle store by `RootId` (store migration); desktop `lastFolderPath` scalar → roots list over IPC; legacy-root reconciliation (resolve `kind: 'legacy'` rows to `path`/`fsa` on first restore).
3. **Queue & sync scoping** — `root_id` in job-queue dedupe keys; `workspace-collection-sync-service` tracks per-root sync state; desktop watcher map (`Map<RootId, Watcher>`); web `FileSystemObserver` behind feature detection.
4. **Store & forest UI** — file-explorer store re-keyed to `(rootId, …)` composites with persisted-state migration; `FileTreeProvider` accepts a forest; TreeTable renders multiple top-level roots; restore banner becomes "Restore access to N folders" (one click re-grants all).
5. **Citations & RAG context** — `rootId` on `RuntimeWorkspaceContextFileMetadata`; disambiguate same relative path across roots in search results and citations.
6. **Snapshot tier + PWA prompt** — `webkitdirectory`/drag-drop import into OPFS as `kind: 'snapshot'` roots; "re-import to refresh" affordance; PWA install prompt in web onboarding. Deferrable.

Cross-cutting: factory reset must clear the roots table, the re-keyed handle store, and OPFS snapshot dirs (update `factory-reset-helpers.ts` in the phase that introduces each store).

## Discovery references

- Current single-root map and blast-radius analysis: session notes 2026-06-09 (web handle cache already stores multiple handles; everything above it is singular; desktop persists one `lastFolderPath`).
- Migration 029 already keys file identity by `(embedding_set_id, source_root_path, path)` — Phase 1 is a normalization (string → FK), not a semantic change.
