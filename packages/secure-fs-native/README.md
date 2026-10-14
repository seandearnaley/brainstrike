# @brainstrike/secure-fs-native

Native filesystem capabilities for authorized Node owners, including Electron
main and the utility/CLI host. Renderers use admitted bridges. Public signatures
and result variants live in [`index.d.ts`](index.d.ts).

## Identity and traversal

`SecureRoot` opens and pins the trusted root directory. `canonicalPath` is derived
from its opened handle, not a pre-open pathname lookup. Root establishment may
resolve a symlink because that path comes from trusted picker/store input;
repository-controlled descendants remain no-follow.

Descendants open component by component relative to the pinned handle, using
POSIX `openat` or Windows handle-relative traversal. Symlinks/reparse points,
`..`, embedded separators and NUL bytes refuse. No pathname fallback is allowed
when the native binding or secure traversal is unavailable.

Each enumeration owns an independent cursor; concurrent calls do not share it or
hold a lock across blocking I/O. `listDir`/`listDirAsync` return entries, inspected
count and visible truncation. Debit inspected work from the caller's budget;
truncation is not complete membership. Bounded file reads distinguish missing,
oversized and unreadable content.

## Revocation and private files

`close()` revokes new operations without blocking. Admitted work retains the pinned
root until it drains; the descriptor releases after the last operation finishes.
A close notification is not proof that in-flight I/O ended.

Private reads validate the opened regular file: exact POSIX `0600`, or current-user
ownership plus a protected Windows DACL containing only the explicit owner
FullControl ACE. They have no additional size limit; missing and unsafe/unreadable
results stay distinct. POSIX opens are nonblocking so a FIFO cannot wait for a writer.

Private writes create an exclusive private temporary file under the pinned parent,
flush and replace in the same directory, refusing unsafe existing targets. Completion
joins I/O, closes and owned temporary cleanup. Failures reject with
`ERR_PRIVATE_FILE_OPERATION` without credential content; the caller owns
serialization. Accepted operations pin before queueing.
Privacy is checked again around I/O, but this does not protect against an
unrestricted malicious process with the same user identity mutating files/ACLs.

Root establishment distinguishes genuine `ENOENT` from `ERR_SECURE_FS_ROOT`.
`tryExclusiveFlock` is POSIX-only; inherited descriptors share its open-file lock,
so close the owned descriptor rather than unlocking the shared lock. Windows
same-directory replacement uses its separate native primitive.

Builds/scripts belong to [`package.json`](package.json). See
[lease](../../docs/agents/host-lease.md) and
[shared contribution/validation policy](../../AGENTS.md).
