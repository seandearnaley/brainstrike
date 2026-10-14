# Writable import flush descriptors

Supports `../state-store.md` interchange durability rules.

## 2026-10-05 — BST-1941 Windows I5

The coordinator observed `EPERM` from `fsyncSync` in `StateStore.importBundle`
after copying a regular file and opening it with `r`. This is separate from
the generation-release incident and the exhaustive WAL test structure change.

[Microsoft's FlushFileBuffers contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
requires write access on its file handle. [Node's filesystem flags](https://nodejs.org/api/fs.html#file-system-flags)
define `r+` as opening an existing file for reading and writing; it does not
truncate the copied file. The correction changes only this descriptor flag.
Copy, fsync, finally-close, validation and failure behavior remain in order.
There is no retry, ignored error, rollback change or alternate filesystem helper.

The existing I5 suite gains controls through real public export/import calls:
the flush boundary verifies regular-file size and bytes, writes back an identical
final byte through the actual descriptor to establish write access, then performs
the real fsync. The original `r` descriptor fails this control with `EBADF` on
macOS; `r+` succeeds without changing imported bytes. Injected fsync and close
errors retain their identity, stop import and leave the copied-file descriptor
closed. Existing streaming round-trip, foreign-root and GC behavior remains.

Local descriptor controls establish access/content/lifetime behavior, not actual
Windows qualification. The changed branch requires an independent review and
actual Windows I5 pass before delivery. Native confirmation of the original
Windows access failure belongs to the coordinator's Windows receipt.

Guard: `packages/state-store/__tests__/i5-export.test.ts`.

CI is disabled due to cost; validation must run locally.
