# SQLite state store

> Read before changing `packages/state-store`. The package is an unwired storage
> foundation: application chat continues using its existing persistence path.

## Writer and durability

- Keep the state DB's sole writing connection on the writer worker. Serialize
  mutations, blob writes and boundary syncs through the store's write chain.
- Use pinned better-sqlite3, WAL, NORMAL streaming commits, secure_delete=ON,
  foreign_keys=ON and wal_autocheckpoint=0. Enable fullfsync on macOS. A step
  boundary performs a FULL marker commit covering all earlier NORMAL commits;
  checkpoint only within that boundary. The auto-checkpoint option is a tracer
  negative control, never an application setting.
- Deliver committed rows only after COMMIT returns. Worker failure rejects
  pending and later requests with its cause; closed readers reject promptly.
  Do not reuse an allocated sequence.
- Verify per-row CRC and contiguous per-thread sequence. A damaged thread is
  read-only; database integrity damage is visible and never triggers deletion.
- Apply forward schema versions transactionally and reject a newer database.
  Preserve existing run rows and settings when upgrading the initial scaffold.
- SQLite authoritative records use validated JSON TEXT, checked boolean
  INTEGERs, UTC timestamp TEXT and caller-minted UUID TEXT. Preserve exact billed
  cost decimals as TEXT. Keep absent legacy-parent FK boundaries explicit.

Guard: `packages/state-store/__tests__/m0-sqlite.test.ts`, `schema.test.ts`,
`i3-corruption.test.ts`, `kill-harness.integration.test.ts`,
`kernel-sync.integration.test.ts`, `m0-coalescer.test.ts`, `lifecycle.test.ts`.
Evidence: `state-store/foundation.md`.

## Root ownership

- Refuse synced roots before creating anything. Check provider directories,
  OneDrive environment roots and POSIX symlink aliases.
- Acquire the root lock before opening SQLite. Identity includes host, canonical
  root, PID and OS process start time; a live owner is never replaced or killed.
- Never take over a lock from another host, including when a callback approves.
  Same-host copied roots require explicit confirmation; stale same-root owners
  use atomic generation takeover with exactly one winning contender.
- Windows uses the real UTC FILETIME process creation time; unavailable identity
  must throw rather than imply that a live process disappeared.
- Release uses one fsynced, closed, exclusively owned temp and atomic rename.
  Before every rename, validate the generation and full owner identity; missing,
  changed, malformed or superseded authority is terminal.
- On Windows, use the existing bounded filesystem retry for release rename only;
  POSIX attempts once. Set released only after publication, clean up only the
  owned temp on failure, and preserve primary plus cleanup causes and temp path.
- Expose detached release retry statistics without changing shared accounting:
  retries count eventual success; exhausted failures retain attempts and codes.

Guard: `packages/state-store/__tests__/d5-root-lock.test.ts`,
`m0-lock-start-time.test.ts`, `m0-lock-release.test.ts`, `i6-synced.test.ts`.
Evidence: `state-store/foundation.md`, `state-store/windows-release-2026-10-05.md`.

## Blobs, purge and interchange

- Store large text as content-addressed files. Verify supplied and existing blob
  hashes, fsync before committing a referencing row, and preserve shared blobs.
- Purge requires the indexer port. Persist and replay the purge intent, reindex
  the tombstone, require explicit nonnegative reference counts and truncate WAL
  before claiming deletion. A pinned reader rejects purge; retry completes it.
- Use the production indexer's state adapter for physical FTS/reference-count qualification. Keep its truth reader on the existing indexer writer worker; do not model state events as canonical files or wire application chat in this foundation.
- Export complete state through a consistent VACUUM INTO snapshot. Defer blob GC
  while exports reference older snapshots; import verifies every manifest hash.
- Flush copied import files through non-truncating writable descriptors; close
  each descriptor in finally and surface flush failures.
- JSONL interchange contains run rows and referenced blob bytes, with a version
  header, CRCs and contiguous sequences. Import validates the complete file before
  inserting rows into an empty run log and preserves timestamps and raw counts.
  Complete authoritative records use the state bundle instead.
- Reset closes writer and indexer handles before deleting every owned store entry
  and removing the root lock. Preserve unrelated files in a shared profile.
- Keep desktop factory-reset profile deletion covering these unwired store files;
  wiring chat or creating a separate reset authority requires a later change.

Guard: `packages/state-store/__tests__/blobs.test.ts`, `i1-purge.test.ts`,
`i2-reset.test.ts`, `i5-export.test.ts`, `jsonl.test.ts`,
`large-thread.integration.test.ts`, `i7-single-writer.test.ts`.
Evidence: `state-store/foundation.md`, `state-store/import-flush-windows-2026-10-05.md`.
