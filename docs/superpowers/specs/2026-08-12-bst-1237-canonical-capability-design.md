# BST-1237 v3: Canonical Native Capability Contract

**Date:** 2026-08-12
**Ticket:** BST-1237 (CWE-59 — workspace file reads must bind to canonical roots across symlinks)
**Supersedes:** PR #2418 (which superseded PR #2410). This is a clean replacement PR, not a patch stack.

## Problem

PR #2418 centralized workspace root authority (`IPC → WorkspaceRootRegistry → pinned native root capability`) and its trust boundary holds, but the native capability contract is not canonical:

1. **Identity is claimed, not derived.** `packages/secure-fs-native/index.cjs` computes `canonicalPath = realpathSync.native(rootPath)` before opening, then the native constructor performs a second, independent path walk to pin the handle. Two racing lookups; the registry's swap check in `mount()` compares `realpath(p)` with `realpath(realpath(p))` and can never detect the swap it exists to catch (Codex P1 on #2418). `index.d.ts` declares `readonly canonicalPath` but the wrapper assigns a mutable public field.
2. **The concurrency promise is wrong-shaped.** One mutex per root is held across entire `openat` walks and read loops on the libuv threadpool, and `close()` takes it on the Electron main thread. Folder disconnect during a slow read stalls main; concurrent reads serialize and park threadpool threads. The README justifies the lock with a Windows-only borrowed-cursor invariant.
3. **The registry violates the contract the PR documents.** The README defines `truncated` as a partial-result signal; `WorkspaceRootRegistry.readDirectory` throws on it, making any directory over 10,000 entries entirely unreadable (regression vs. the adapter it replaced).

Plus four registry-side review findings: session-root double-mount leak, corrupt `rootsList` bricking `addRoot`/`removeRoot`, a dead `workspaceRootRegistry` injection seam, and a redundant renderer `saveLastFolder` write that rejects a successful-but-unpersisted folder pick.

## Design

### 1. Native contract — `@brainstrike/secure-fs-native`

**Identity (open-then-derive).** `new SecureRoot(requestedPath)` opens the root in native code directly from the requested path:

- Root open follows symlinks (root paths come from the trusted folder picker or persisted store, never from repository content): POSIX `open(path, O_RDONLY|O_DIRECTORY|O_CLOEXEC)`; Windows `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` and **without** `FILE_FLAG_OPEN_REPARSE_POINT`.
- Canonical identity is derived **from the opened handle**: `fcntl(F_GETPATH)` (macOS), `readlink("/proc/self/fd/N")` (Linux), `GetFinalPathNameByHandle` (Windows; strip/normalize the `\\?\` prefix).
- `canonicalPath` becomes a native-backed getter; the JS wrapper is a pure passthrough and `realpathSync` is deleted. There is exactly one path walk in the system.
- Descendant resolution is unchanged: component-relative `O_NOFOLLOW` / `OBJ_DONT_REPARSE` opens; `..`, separators, and NUL rejected lexically; symlinks fail closed.

**Revocation (drain, don't yank).** `RootState` drops the I/O mutex. Each operation atomically snapshots a `shared_ptr` to the handle state; `close()` marks the root revoked — new operations fail closed immediately (`null` / `unreadable`) — and the descriptor physically closes when the last in-flight operation releases its reference. `close()` never blocks the main thread. Contract wording: *close() guarantees no new operations begin; in-flight reads drain against the pinned object.*

**Concurrency (no per-root serialization).** POSIX already opens a fresh `.` fd per operation. Windows root enumeration stops borrowing the pinned handle's directory cursor: each listing reopens the root relative to itself (`NtCreateFile` with `RootDirectory = root`, empty object name), giving an independent cursor per listing. If empty-name relative reopen proves unreliable on any supported Windows version (verify in native tests), fall back to `ReOpenFile`. With per-op cursors the lock's only justification disappears.

**Bounds.** `listDir` keeps `{entries, inspected, truncated}` partial-result semantics (callers debit `inspected`). The 16 MiB native read cap stays; the registry boundary throws loudly if `getFileSizeConfig().maxFileSize` exceeds it rather than letting every read return `unreadable`.

**README** is rewritten around the three contract dimensions: identity (handle-derived), revocation (drain semantics), concurrency (no serialization; per-op cursors).

### 2. Registry — `WorkspaceRootRegistry`

**Mount-then-ask.** `mount()` constructs the capability from the entry path and reads `secureRoot.canonicalPath` as the authority; the pre-claim + vacuous swap check is deleted. `resolveCanonicalRoot` survives only as a presentation-level comparator for entries that cannot be mounted (dedup of unavailable stored roots) — never on the authority path.

**Dedup closes the double-mount leak.** After mounting, `addRoot` dedupes by capability-reported canonical path across `this.mounted` ∪ stored entries. A hit on a session root reuses/replaces that mount instead of minting a second capability. `restoreRoots` seeds `retainedCanonicalPaths` from already-mounted session roots.

**Corrupt store recovery.** `restoreRoots`/`convergeDatabase` keep fail-loud semantics (unknown mount set ≠ authoritative zero; `rootsDbQuery` never called on corrupt store). `addRoot` and `removeRoot` instead quarantine an unparseable `rootsList` under a `rootsList.corrupt` storage key, log the corruption at error level (visible in Flight Recorder), and proceed with a fresh list. Nothing is coerced — the raw value is preserved for diagnosis — and the user always has a way out.

**Deletions.**
- The dead `workspaceRootRegistry` injection option in `file-system-ipc.ts` (its unregister would dispose a caller-owned registry).
- The renderer-side `saveLastFolder` write after `fs:requestDirectoryAccess` (main owns the preference; the write also throws for successful-but-unpersisted picks).
- Fold in React Doctor's three warnings on the registry (parallelize independent awaits; combine filter/map chains).

**Truncation is not fatal.** `readDirectory` returns the partial listing plus truncation metadata instead of throwing.

### 3. Truncation plumbing to the explorer

- The file-system adapter `readDirectory` contract returns nodes plus truncation metadata; the electron path threads `{inspected, truncated}` from the native result through IPC.
- The parent directory's node carries `truncatedChildren: true`; the tree renders one non-selectable tail row ("Showing first 10,000 entries") for such directories.
- Web/dev-fixture/mock adapters report `truncated: false`.
- Read `docs/agents/explorer-search-tapestry.md` and `docs/agents/ui-conventions.md` before touching these surfaces; update both docs (and the file-system contract docs) in the same change.

### 4. Error handling

NO SILENT FALLBACKS, concretely:

- Revoked capability → explicit fail-closed statuses on new operations.
- Corrupt `rootsList` → quarantined + surfaced on add/remove; fail-loud on restore/convergence.
- `maxFileSize` above the native cap → throw at the registry boundary.
- Truncated listing → partial data with a visible UI row, never a silent partial and never a hard failure.
- Native binding unavailable → error/null, no path-based fallback (unchanged invariant).

### 5. Testing (RED/GREEN)

- **Native suite:** handle-derived identity equals the resolved path for symlinked root inputs (e.g. `/tmp` on macOS); close-during-in-flight-read drains without blocking and subsequent operations fail closed; concurrent listings have independent cursors; existing symlink/traversal/replacement-race/oversize suites remain green.
- **Registry:** mount-then-ask (no pre-claim), session-root re-add dedupes instead of double-mounting, corrupt-store quarantine on add + fail-loud on restore, truncated listing returns partial nodes + flag, oversized `maxFileSize` throws.
- **Explorer:** tree renders the truncation row; >10k-entry fixture stays in `*.integration.test.*`.
- Gate: `pnpm lint && pnpm type-check && pnpm build && pnpm test` green in the same run.

### 6. Delivery

Branch `claude/bst-1237-canonical-capability` off latest `main`; new PR supersedes #2418 (do not merge #2418/#2410), same Linear ticket BST-1237; closing pointer comment on #2418 once the replacement PR is up.

## Explicitly out of scope

- Cross-session inode identity for persisted roots (persisted identity remains path-based; a pinned handle already refers to the object, so post-open swaps are structurally irrelevant within a session).
- Any write-path capability work; the contract stays read-only.
- Sync/CRDT groundwork beyond what the data layer already carries.
