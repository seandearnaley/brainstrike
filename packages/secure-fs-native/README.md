# `@brainstrike/secure-fs-native`

A filesystem *capability* for Electron main-process code. A
`SecureRoot` pins one directory handle; the contract has three dimensions:

**Identity.** The constructor is the only resolver. It opens the requested
root directly — following symlinks for root establishment only, because root
paths come from the trusted folder picker or persisted store, never from
repository content — and derives `canonicalPath` from the opened handle
(`fcntl(F_GETPATH)` on macOS, `readlink /proc/self/fd` on Linux,
`GetFinalPathNameByHandle` on Windows). No pre-open path lookup vouches for
the capability; the pinned object is the authority for its own identity.

**Traversal.** Every descendant directory and file is opened
component-by-component relative to the pinned handle: POSIX
[`openat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)
with `O_NOFOLLOW`, Windows
[`NtCreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
with `OBJECT_ATTRIBUTES.RootDirectory`, `OBJ_DONT_REPARSE`, and
`FILE_OPEN_REPARSE_POINT`. Symbolic links/reparse points, `..`, separators
inside components, and NUL bytes fail closed. Built on stable
[Node-API](https://nodejs.org/api/n-api.html) via the
[Electron native-module workflow](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/).

**Revocation.** `close()` never blocks: it revokes the capability for *new*
operations (which fail closed with `null` / `unreadable`) while in-flight
operations drain against the pinned object; the descriptor is released when
the last one finishes.

**Concurrency.** Operations do not serialize. Each enumeration owns an
independent directory cursor (POSIX opens a fresh `.` descriptor relative to
the root; Windows reopens the root handle-relatively), so concurrent calls
cannot share or corrupt a cursor, and no lock is held across blocking I/O.

`listDir(relativePath, maxEntries)` bounds enumeration natively and returns
`{ entries, inspected, truncated }` — `truncated` is a partial-result signal,
not an error; callers must debit `inspected` from their traversal budget and
surface truncation visibly. `readFile(relativePath, maxBytes)` applies its
byte limit before returning content and distinguishes `not-found`,
`oversized`, and fail-closed `unreadable`. The async methods preserve the
same contracts on native workers.

`readPrivateFileAsync(relativePath)` reads a regular file only after validating
privacy on its opened handle: exact `0600` permissions on POSIX, or current-user
ownership and a protected Windows DACL containing exactly one explicit owner
FullControl ACE without inheritance. Missing files return `not-found`; unsafe
or unreadable files return `unreadable`. Private reads have no additional size
limit. POSIX opens are nonblocking so a FIFO is rejected without a writer.

`writePrivateFileAsync(relativePath, content)` creates an exclusive temporary
file beneath the pinned parent with private permissions before writing bytes,
flushes it and atomically replaces the target in that same directory. Existing
unsafe targets are refused. Completion joins all native I/O, handle closes and
owned temporary-file cleanup; failures reject with `ERR_PRIVATE_FILE_OPERATION`
without credential content. The caller owns serialization. Accepted private
operations pin the root before queueing, so `close()` revokes later calls while
accepted calls finish. No additional ownership restriction is imposed on POSIX.

Root-establishment failures carry `ENOENT` only for a genuinely missing path;
other failures carry `ERR_SECURE_FS_ROOT`. A trusted root may resolve symlinks
as described above; descendants remain no-follow. Privacy is checked again
after reads and before replacement, but this is not protection against an
unrestricted malicious process with the same user identity mutating files or
ACLs concurrently. No pathname fallback or competing credential queue exists.

There is deliberately no path-based fallback. If the native binding or secure
traversal is unavailable, callers receive an error/null result and must fail
closed.
