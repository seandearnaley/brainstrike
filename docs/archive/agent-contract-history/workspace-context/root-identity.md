# Main and Focused root identity — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED".
Read before changing Main/Focused semantics, restore ordering, thread/run root binding, the initial root manifest, or the server-side root reorder.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Two DISTINCT root concepts exist in a multi-root workspace — never conflate
them (the pre-split code did, with a false "first root is the primary/focused
one" comment):

- **MAIN root** = the assistant's OPERATING root. Defined as
  `activeRootIds[0]` in the file-explorer store (insertion-ordered, persisted
  in file-explorer-storage v5 — persisting the order persists the choice; no
  extra field, no DB migration). Drives the hooks `primaryCwd` (the stdin
  `cwd` of UserPromptSubmit/Stop/Session events and the spawn cwd of GLOBAL
  hooks) and the model-facing "main root path"
  (`listWorkspaceContext.workspaceRootPath`). Stable: only "Set as main" (a
  pure store reorder via `setMainRoot`) or disconnecting the main root
  (which promotes `activeRootIds[1]`) changes it. Re-adding a removed root
  appends to the END — a re-added ex-main root is demoted (visible +
  recoverable, by design).
  - **Restore-order preservation (`setActiveRoots`, `active-root-actions.ts`):**
    the desktop boot restore (`runMultiRootRestore` in
    `packages/file-explorer-hooks/src/use-file-system.ts`) rebuilds
    `activeRootIds`/`rootDescriptors` from a SEPARATE main-process-persisted
    `rootsList`, owned only by
    `apps/desktop/src/ipc-domains/workspace-root-registry.ts`, which is plain
    add-order and has NO notion of Main. IPC and the renderer are projections:
    add/restore/disconnect complete in that registry before renderer state
    changes. A rejected disconnect leaves renderer state intact. Unavailable or
    transiently unmountable entries remain persisted with
    `permissionState:'unknown'`; they are retried later and excluded from the
    mounted capability set and DB live-root convergence. The legacy
    `lastFolderPath` is presentation-only and may reference only an
    already-persisted mounted root; it never inserts or removes roots.
    `setActiveRoots` is therefore
    ORDER-PRESERVING, not a blind overwrite: ids still reported keep their
    existing relative order from the already-rehydrated store (the Main slot
    survives), a newly-reported id not previously known appends at the END,
    and an id no longer reported as granted drops out. This
    is what makes the storage-v5 "persisting the order persists the choice"
    claim above actually hold across a restart — without it, `runMultiRootRestore`
    calling `setActiveRoots(storedDescriptors)` after hydration would silently
    re-derive `activeRootIds[0]` from the rootsList's add-order and demote the
    user's declared Main root on every restart.
- **FOCUSED root** = SELECTION state (`currentFolderId`). Drives the Terminal
  panel's DEFAULT cwd, selection scoping, and the selection write-back default
  (`resolveWriteBackTarget` untouched). It flips on any incidental click
  (`handleTreeInteraction` in `file-explorer-sidebar.tsx`), so it must NEVER
  drive hooks/model cwd. Surfaced visually, never described as the
  assistant's root.

**The Terminal's cwd is FOCUSED-by-default, PINNED-when-asked, and the pin is
SHELL-ONLY (BST-1457).** `TerminalPanel` follows the focused root until a
surface publishes a `terminal-target-store` pin — "Open in Terminal" on a
Worktree Map card, the Mode chip's worktree menu, or a Folder chip root row. A
pin carries `{ cwd, rootId }` because the two differ for a nested checkout,
survives focus changes on purpose, and is released by the panel's own "Follow
focused folder" control or by factory reset. This is the ONE place a
FOCUSED-root default is deliberately overridable: unlike hooks/model cwd
(which must never follow focus), a terminal is something the user aims
explicitly. The pin scopes ONLY the shell (`HumanTerminal`) — the panel's
Command sessions surface (`CommandSessionInventory`) always takes the FOCUSED
root, never the pin, so its destructive `stop`/`remove`/`write` actions can
never silently retarget onto a checkout pinned in a different root. An
explicit "Open in Terminal" also forces the panel back to the shell surface
even if Command sessions was last selected — the requested PTY must never
start invisibly behind another tab.

**Forge identity (BST-1391) follows MAIN, never FOCUSED.** The workspace
bar's `PrChip` and the BranchChip's forge diagnostic both resolve their
`gh`-backed pull-request status from the MAIN root's repository (the bar's
`primaryRoot`, `activeRootIds[0]`) — the same root that drives hooks/model
cwd. A FOCUSED selection must never drive which repository's remote gets
parsed or which branch's PR gets fetched, for the identical reason it must
never drive cwd: it flips on incidental clicks, and a forge lookup silently
following it would attribute a PR to the wrong repository the instant the
user clicks around the tree.

**Request fields** (`packages/assistant-contract/src/runtime-data.ts`): the
wrapper attaches `mainRootId` (= adapter `activeRootIds[0]`) and `mainRootPath`
(the descriptor's absolute path) per request. They are an ORDERING HINT for the
server — a preference, not a security boundary. The server may use the path to
match that ordering hint after reconnects; neither field is the durable
thread-binding authority. `workspaceRootPath` stays the FOCUSED root (selection
scope) — unchanged.

**Thread/run binding:** Desktop data-stream threads persist their first
request's explicit Main root in `mastra_threads.metadata` as
`operatingRootId` plus display-only name/path fields. The durable id, not the
path or label, is the execution authority. At first request preparation,
app-shell resolves the mounted adapter root path to exactly one live DB
`roots.id`; it fails visibly rather than persisting an adapter id or guessing.
Later global Main/Focused changes do not retarget that thread or its composer
chip. Request preparation reuses the persisted id and emits
`boundWorkspaceRootId`; approval/resume preparation is pinned by an in-memory
copy before the metadata-store rerender can land.
Restored tab ids can become selected before their `mastra_threads` rows have
loaded. That state keeps the composer disabled and causes root resolution or
persistence to fail visibly; it must never be treated as missing metadata and
rebound to the current Main root.
Desktop validates that id against its server-loaded live DB roots before hooks
or the initial manifest can use another mounted root, then orders the bound root
first. An omitted native workspace-tool `root` resolves to the binding. An
explicit selector for another currently mounted root remains an observable
cross-root operation. An explicitly
blank selector is invalid and never broadens an optional search to all roots or
falls through to the thread binding. Bound-root resolution requires an
authoritative `workspaceRoots` inventory; if DB enrichment is unavailable, the
tool fails visibly instead of comparing the durable id with a synthesized
path-backed root or silently clearing the binding. A missing, stale, or
disconnected bound id fails visibly as `bound_workspace_root_unavailable` with
HTTP 409; it never path-falls back or silently adopts the new global Main root.
The one intentional omission exception is
`readWorkspaceContext` with no explicit `filePaths`: renderer-selected paths and
Tapestry ranges are relative to the FOCUSED `workspaceRootPath`, so that
selection-default read resolves the focused path against the authoritative
inventory instead of the thread binding. If the inventory is unavailable, the
selection-default read fails visibly; focused renderer state never authorizes a
path-backed root. Supplying `filePaths` restores the normal omitted-root binding
rule. Disconnect transitions also revoke
already-enriched in-flight runtime snapshots, while a later authoritative live
root load clears that revocation after reconciliation/reconnect.

**Initial workspace-root manifest** (`packages/agent/src/workspace-root-manifest.ts`):
every fresh hosted-provider turn receives one `system` message before the
model's first action. Existing leading system context stays ahead of it, so
Desktop workspace instructions retain their documented frontmost precedence.
The bounded JSON data block contains only the
server-resolved root selector, display name, canonical path, and Main/Focused
roles — never a tree, file list, selection list, or glob result. It is capped at
3,000 serialized characters and five roots; Main and Focused are prioritized,
and any remainder is reported with explicit `shown`/`omitted` counts. Exact
root selectors are never truncated: an unexpectedly oversized selector is
omitted and counted rather than becoming an unusable or misleading id. Root
names/paths are clipped, JSON-escaped, and explicitly described as inert data.
`listWorkspaceContext` remains the detailed, refreshable source for complete
root inventory, selections, indexing, ranges, and budgets.

The injection lives at the shared `toAiSdkStyleStream` boundary, after Desktop
has enriched the runtime but before Mastra memory selects the current turn, so
it covers OpenAI, Anthropic, OpenRouter, and Hosted Web consistently. Desktop
with a successful empty DB query emits `state: available, count: 0`; Hosted Web
or degraded/legacy Desktop state emits `state: unavailable` and never invents
a client/path-derived selector. The compact built-in local model is excluded to
preserve its 8,192-token context budget.

**Server reorder** (`apps/desktop/src/assistant-server/workspace-roots.ts`):
`enrichRuntimeDataWithWorkspaceRoots` loads live DB roots (`created_at ASC`)
then prioritizes an exact `boundWorkspaceRootId` when present; otherwise it
calls the pure `orderWorkspaceRoots(roots, mainRootId, mainRootPath)` — match by
rootId first, else by resolved absolute path (covers legacy client ids that
diverged from DB ids; web enrichment never runs, FSA roots have null paths).
An unmatched binding stays unmatched so tool execution can fail visibly;
unmatched/absent Main keeps `created_at` order (the legacy tiebreak) with a
debug log. `roots[0]` is therefore GENUINELY the thread-bound/Main root — no
`buildHookManager` change was needed. On a DB load/query failure, RuntimeData
remains unenriched and workspace-tool authorization fails closed; the renderer's
FOCUSED `workspaceRootPath` is selection state only and never becomes a
synthesized root. A successful zero-root query records an explicit
`workspaceRoots: []`. This is distinct from an unresolved/query-failed root
inventory and lets `listWorkspaceContext` report the valid empty-workspace state
without disguising a bridge failure. Enrichment also clears any stale FOCUSED
`workspaceRootPath` in that zero-root state; otherwise the trusted empty
inventory and renderer focus would be inconsistent and stream initialization
would fail before the empty-workspace result could be reported.
The desktop HTTP boundary strips any client-supplied `workspaceRoots` before
enrichment. Only the DB result may populate the trusted manifest/tool inventory;
renderer fields can order or focus roots but can never substitute adapter ids
for the durable selectors accepted by native tools.

**Known issue (out of scope here, filed separately):** nothing ever
transitions `roots.status` off `'live'` (`reconcileRoots` never UPDATEs), so
the server can still serve DISCONNECTED folders in `workspaceRoots`; this
feature only reorders. The client's `activeRootIds` contains only MOUNTED
roots, which is why the client-declared main avoids the phantom-root problem
by construction.

