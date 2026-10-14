# What a fresh start clears: UI state, session stores, desktop userData keys — evidence

Supports `docs/agents/platform-contracts.md` § "FACTORY RESET CONTRACT".
Read before adding a persistent store, changing `clearPersistentUiState`, or touching the main-process `electron-storage.json` authority keys. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
“Factory Reset Brainstrike” = true fresh start.

Rules:
- Wiping DB alone is NOT enough.
- Renderer must boot as if never used.

Implementation:
- Update:
  - packages/app-state/src/factory-reset.ts
  - Ensure clearPersistentUiState() includes:
    - All new persistent UI store keys (e.g. `hook-trust-store` — the
      security-sensitive per-root hook approvals; reset drops every approval so a
      re-mounted repo's hooks require fresh review — see TOOL-LIFECYCLE HOOKS;
      and `worktree-setup-consent.v1` — per-repository approvals and denials for
      `.brainstrike/worktree-setup.sh`, keyed by Git common directory).
    - Session composer text (`assistant-composer-drafts.v1`) is cleared by the
      blanket sessionStorage clear and the app-shell composer-store reset.
    - Electron renderer storage bridge.
    - IndexedDB (enumerated + fallback list).
    - CacheStorage.

Storage deletion is fail-visible. Electron renderer storage, secrets, and
settings failures (including a fulfilled secrets response with
`success:false`), IndexedDB `error` / `blocked` events or synchronous deletion
exceptions, CacheStorage failures, and OPFS failures all produce an incomplete
reset result. The IndexedDB enumeration compatibility fallback is the sole
tolerated degradation: browsers without `indexedDB.databases()`, or browsers
where enumeration rejects, still delete the explicit Brainstrike fallback
names. Never convert a failed deletion into reset success.

The main process uses one `getSecretsService()` singleton for secrets IPC,
provider auth, and MCP external bearer resolution. MCP bearer references are
namespaced keys inside that existing encrypted store, not a second credential
database. The bearer transport resolves on every request and never caches token
material, so the existing secrets `clearAll` step is the complete reset
authority: after reset, an already-created transport closure fails visibly as
credential-missing before network I/O. No extra bearer runtime purge exists or
is needed unless token caching is introduced later (which would require this
contract and paired reset tests to change together).

If you add new persistence (Caches API, service worker, filesystem handles, etc.):
- Document it next to the helper.
- Integrate into reset pipeline.
- Otherwise stale embeddings/providers may reappear.

Dependency-free session stores owned by `app-shell` share one authoritative
resetter list, `APP_SHELL_SESSION_STORE_RESETTERS`; this includes diagnostics
health/seen state, assistant composer commands, browser tabs, thread search,
command palette, quick open, and one-shot worktree checkout intent. Production
registers every list member separately through
`registerFactoryResetSessionStore`, preserving per-store failure isolation,
while `packages/app-shell/vitest.setup.ts` invokes
`resetAppShellSessionStores()` to drain the same list before every test. Do not
maintain a second test-only reset list: that recreates the drift BST-938 found,
where shuffled tests inherited a disabled diagnostic sink or active search from
an earlier test. Component-coupled app-shell stores and feature-package stores
keep their own production registrations plus explicit focused-test setup;
preloading those in the global helper would bind real dependencies before test
modules can install their mocks. The regression in
`packages/app-shell/src/__tests__/session-store-test-isolation.test.ts` pins the
cross-test boundary, while
`register-factory-reset-session-stores.test.ts` pins production registration.


Desktop MAIN-PROCESS storage (`ElectronStorageAdapter`, one
`electron-storage.json` under `app.getPath('userData')`) is covered by the same
wholesale userData wipe — no per-key wiring. The keys it owns that MATTER for a
fresh start:

- `rootsList` — the connected workspace roots, owned only by
  `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (see
  workspace-context.md, MAIN vs FOCUSED).
- `rootsList.corrupt` — quarantined bytes from a malformed `rootsList`, written
  once alongside an ERROR log by `readStoredRootsOrQuarantine` so a corrupt
  list self-heals instead of bricking root restore. It still holds the paths
  the user had granted, so reset must take it too.
- `recentRootsList` (BST-1395) — the ledger of folders the user has ALREADY
  granted this app (`workspace-recent-roots.ts`). Deliberately SEPARATE from
  `rootsList`: disconnecting a root must not revoke the grant, because the
  grant is what points the picker-less `fs:addRootByPath` — driven by the
  composer workspace bar's Recents list — at a previously granted folder. It
  sits in the SAME trust class as `rootsList` + `fs:restoreRoots`, not above
  it. Reset therefore has to clear it — a surviving ledger would keep offering
  picker-less mounts of folders a "true fresh start" says were never granted.
- `recentRootsList.corrupt` — quarantined bytes from a malformed
  `recentRootsList`, the exact counterpart of `rootsList.corrupt`. Written once
  alongside an ERROR log so a corrupt ledger self-heals instead of bricking
  Recents; covered by the same wholesale userData wipe.
- `notesVaultRoots` (`NOTES_VAULT_ROOTS_STORAGE_KEY`,
  `apps/desktop/src/notes-vault-ipc-handlers.ts`) — the notes-vault sibling of
  `rootsList`: granted vault folders, re-opened without a picker. Same
  reasoning, same wipe.
- `worktreeSettings` (`WORKTREE_SETTINGS_STORAGE_KEY`,
  `apps/desktop/src/assistant-server/worktree-settings.ts`) — the user-chosen
  managed-worktree directory path plus the setup command executed on worktree
  creation. Reset must not leave either a stale custom directory or command.

**CORRECTION (2026-09-21):** "one of the 21 `brainstrike_*` relations" below is
stale — `BRAINSTRIKE_RESET_TABLES` holds 34 today. The ruling (the ledger rows
are cleared, the directories on disk are not) is unchanged.

Managed worktree DIRECTORIES themselves (BST-1390) live OUTSIDE `userData` —
the default is `~/.brainstrike/worktrees` [D3] — so the wholesale userData
wipe above does not cover them, and neither does clearing `worktreeSettings`
(that only clears the STORED preference, not the directory it names). Factory
reset does clear the `brainstrike_worktrees` LEDGER: it is one of the 21
`brainstrike_*` relations in `BRAINSTRIKE_RESET_TABLES`
(`packages/db/src/reset-table-registry.ts`), the set every table-enumerating
reset path clears (see the reset-table registry section below). It does NOT
delete the worktree directories on disk: they can hold uncommitted work, and a
reset silently removing a folder full of it is exactly the failure mode
`archive`'s snapshot gate exists to prevent. Deleting them is a separate,
explicitly confirmed action — and today's reset result carries no path or
count for them either way: `DesktopFactoryResetResult`
(`apps/desktop/src/desktop-reset-platform.ts`) is just `{ success, message? }`,
so a caller who wants to know what happened to the managed directory has to
read it themselves, not read the reset result.
- `lastFolderPath` — presentation-only.

The renderer-facing `storage:*` bridge cannot mutate any of the root/vault
authority keys above (BST-1401). `setItem` and `removeItem` reject them by exact
key, `setItem` rejects non-string IPC values before persistence, and `clear`
enumerates and removes only renderer-owned records. That selective clear fails
closed when the durable file could not be loaded; it never recovers corruption
by erasing authority records it could not preserve. The full
desktop factory-reset handler remains the sole whole-profile wipe; it deletes
the userData entries in main after the reset barrier closes, then calls
`storage.clear()` before replacing the renderer. That post-deletion clear is
required even though the file is gone: the main-process adapter is long-lived,
so its in-memory cache must be emptied before a replacement renderer can read
or later repersist stale authority records. E2E root-ledger
seeding and the E2E reset harness's full clear use separate channels that main
registers only in explicit Electron test mode, so production tests do not
require a production bypass. Preload and main use the same `--test-mode` /
`ELECTRON_IS_E2E_TEST=true` predicate, and the preload builds its seed-key set
from main's authoritative `MAIN_OWNED_DESKTOP_STORAGE_KEYS` tuple directly
(the pure `platform/desktop-storage-authority.ts` module bundles into the
preload — see IPC CONTRACT MODULES below).

That coverage is pinned by
`apps/desktop/src/__tests__/main/desktop-factory-reset-storage-ledgers.test.ts`,
which seeds a REAL `electron-storage.json` (all of the keys above, including
both `.corrupt` quarantines) into a REAL temp userData dir and asserts the file
is gone and `logs` is the only surviving entry. The ordering contract for the
main-process cache clear is pinned by
`apps/desktop/src/__tests__/desktop-reset-platform.test.ts`.

Renderer module-scoped state, `roots/root-registration-events.ts` (BST-1400):
a per-key registration GENERATION counter (`seqByKey`) the await-root-
registration seam uses so `useWorkspaceBar` can await a root's durable id
landing instead of polling the database for it. It is DELIBERATELY NOT
registered with `registerFactoryResetSessionStore` — the one case in this
contract where the right answer is "do not wire it, and say why here so
nobody 'fixes' the omission":
- A reset wipes the DB `roots` table this counter describes but leaves the
  counter itself untouched, so after a reset it can be stale (nonzero for a
  path with no live row). That is harmless because the seam's ONLY consumer
  (`resolveRootIdAfterReconciliation` in `packages/app-shell/src/hooks/
  use-workspace-bar.ts`) never reads the counter as an absolute — it captures
  a snapshot BEFORE its first failed read and only accepts a STRICTLY LATER
  generation, so a stale (pre-reset) count can structurally never satisfy a
  wait captured after it.
- Wiring a resetter would make this WORSE: clearing the counter mid-session
  (the reset-without-reload path this contract exists for) would strand any
  IN-FLIGHT waiter whose captured `since` sits above the post-reset
  generation the reset rebumps to — that waiter can then never be satisfied
  and runs its full bounded timeout, raising a destructive "Folder added, but
  not attached to this thread" toast for a request that should have
  succeeded.

That reasoning is pinned by a test that drives the REAL reset pipeline (not
the module's own test-only `resetRootRegistrationEventsForTests` helper,
which exists only for cross-test isolation) —
`packages/app-shell/src/__tests__/register-factory-reset-session-stores.test.ts`
— `'leaves root-registration-events untouched — it is deliberately NOT wired
into factory reset'`. If this module ever needs a resetter for some other
reason, that test (and this entry) must be updated together, and the
in-flight-waiter regression above must be solved first (e.g. an
`AbortSignal` per waiter) — not merely `seqByKey.clear()`.

If main-process storage ever moves outside `userData` (or gains a preserved
entry name), every one of these needs explicit reset wiring plus an update
here.
