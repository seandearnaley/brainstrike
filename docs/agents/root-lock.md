# Root lock

## One owner per data root

A data root has one owner: the process that opened its `StateStore`. On desktop
that is the headless host child; for the CLI it is the CLI process itself
(ADR-0031). `RootLock.acquire(root)` takes an OS lock on `<root>/lock/root.lock`
and a second opener, in any process, gets `RootLockedError`. The lock is never
waited for, broken, taken over or guessed stale: the OS drops it when its owner's
descriptor closes, including when the owner is killed.

`secure-fs-native`'s `tryExclusiveLock` holds it on one native handle that no
child process inherits: `flock(2)` on an `O_CLOEXEC` descriptor on POSIX,
`LockFileEx` on a non-inheritable handle on Windows.

The lock file holds no owner record. Nothing reads a PID, start time or token to
decide ownership; holding the lock is the only proof. The root's identity is
`canonicalRoot` (`fs.realpathSync.native`).

## Private roots

The host makes its root private before it opens the store (`secureDirectory`):
`0700` and owned by the current user on POSIX, the user's owner and DACL on
Windows (`secure-fs-native`). An elevated Windows token defaults new objects'
owner to `BUILTIN\Administrators`, so every Windows process entry that can
create state-store objects first imports `@brainstrike/secure-fs-native/default-owner`
(the entry list is in
`scripts/__tests__/windows-default-owner-entry-contract.test.mjs`).

## Children

Children the host starts (commands, hooks, MCP servers, terminals, LSP) never
hold the root. On Windows the host's kill-on-close Job ends them when the host
ends. On POSIX the host ends their process groups when it closes; a host that is
SIGKILLed leaves any detached groups running, and they still do not hold the
root.

Decision: [ADR-0031](../adr/0031-canonical-process-model.md), stage 3.
Implementation: `packages/state-store/src/lock.ts`.
