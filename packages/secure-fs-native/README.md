# `@brainstrike/secure-fs-native`

This package provides a synchronous, read-only filesystem capability for Electron main-process
code. A `SecureRoot` pins one canonical directory handle. Every descendant directory and file is
then opened component-by-component relative to that handle; symbolic links/reparse points and
`..` traversal fail closed.

The implementation follows the operating-system primitives intended for race-free relative
resolution:

- POSIX [`openat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html) with
  `O_NOFOLLOW`, plus descriptor-relative `fstatat` enumeration.
- Windows [`NtCreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
  with `OBJECT_ATTRIBUTES.RootDirectory`, `OBJ_DONT_REPARSE`, and
  `FILE_OPEN_REPARSE_POINT`.
- Stable [Node-API](https://nodejs.org/api/n-api.html), built with the
  [Electron native-module workflow](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/).

There is deliberately no path-based fallback. If the native binding or secure traversal is
unavailable, callers receive an error/null result and must fail closed.

`listDir(relativePath, maxEntries)` bounds enumeration inside the native layer and returns
`{ entries, inspected, truncated }`; callers must debit `inspected` from their traversal budget.
Each listing opens an independent directory file object, so concurrent multi-buffer enumeration
cannot share cursor state. `readFile(relativePath, maxBytes)` similarly applies its byte limit
before returning content and distinguishes `not-found`, `oversized`, and fail-closed `unreadable`
results. The async methods preserve the same contracts on native workers.
