# Composer workspace bar — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED".
Read before changing the Folder, Branch, or Mode chips, thread checkout metadata, Recents, or the Finder folder drop.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

- Composer **workspace bar** (`packages/assistant-ui/src/workspace-bar/`,
  wired by `packages/app-shell/src/hooks/use-workspace-bar.ts` +
  `use-thread-checkout-status.ts`, mounted in the composer stack as a SIBLING
  of ThreadContextMeter — never nest it there; the meter is being reworked).
  It replaced `operating-root-chip.tsx` (retired in BST-1396) and is ALWAYS
  visible, single root included: BST-1396 removed the >=2-roots gate because
  the bar's job is ORIENTATION, not disambiguation. Zero roots render the
  "Choose a folder" CTA rather than nothing.
  - Folder chip: this thread's PRIMARY (= persisted `operatingRootId`, else
    the current MAIN root) plus `metadata.secondaryRootIds` as a `+N` badge
    and per-root rows. The primary's `rootId` is ALWAYS a durable `roots.id`
    — with no persisted binding, the MAIN root's row is resolved BY PATH
    (never an adapter id), and an unresolvable path leaves the chip's primary
    undefined rather than inventing one.
  - **"Make primary" re-binds the THREAD** through the same three
    `operatingRoot*` metadata keys `persistThreadRootBinding` writes, in ONE
    metadata write together with the secondary set. It NEVER calls
    `setMainRoot` — the global MAIN root is a workspace-wide ordering choice
    and stays untouched. "Remove from thread" likewise only edits
    `secondaryRootIds`; it never disconnects the folder from the workspace.
    While checkout mode is Worktree, making a secondary primary includes the
    Local checkout transition in that SAME write, so the operating root and
    checkout record never disagree. The selected secondary becomes primary,
    every existing secondary except that selected root remains attached, and
    the former worktree primary is removed from the thread. That removal keeps
    a stale action from re-promoting a managed worktree while the checkout mode
    remains Local; re-entering it goes through the worktree picker. A success
    toast makes the implicit Local transition and worktree removal explicit. The secondary named by
    `checkoutLocalRootId` keeps its Remove action visibly disabled with “This
    folder is where Hand off returns to.”; other secondary actions are unchanged.
    A failed write retains the prior folder set and checkout record. The
    disabled return action remains keyboard-focusable and exposes its
    full-contrast reason as an accessible description.
  - "Add folder…" adds the folder GLOBALLY (the existing multi-root
    `addRootDirectory` flow) AND records it as a thread secondary. The durable
    `roots` row is written by the roots-reconciliation effect, so the id
    lookup AWAITS that effect's own "root registered" notification
    (`roots/root-registration-events.ts`, BST-1400) instead of polling the
    database — a module-scoped event bus, since `useWorkspaceBar` renders as a
    REACT SIBLING of the `RootIdentityProvider` subtree that owns
    `useRootsReconciliation` and cannot reach its callbacks through context.
    The wait is still BOUNDED (`ROOT_ROW_WAIT_TIMEOUT_MS`, ~5 s, same budget
    the old 20 x 250 ms poll had). Exhaustion is not a silent no-op: it logs
    and raises a "Folder added, but not attached to this thread" toast. The
    seam is EPOCH-based (a per-key generation counter), not a one-shot flag —
    re-adding a removed folder mints a fresh adapter id and is a genuine
    SECOND registration of the same path, so a plain "ever registered?" flag
    would resolve stale against a row that is still absent; a waiter instead
    captures the generation before its first failed read and only a strictly
    later one satisfies it.
  - Mode-chip checkout metadata is owned by `use-thread-checkout.ts`. Selecting
    a worktree first resolves its mounted path to a durable live `roots.id`, then
    uses the workspace bar's serialized folder-write queue to persist the
    `checkout*` fields, full `operatingRoot*` triple, and secondary-root demotion
    in ONE metadata write. `checkoutLocalRootId` durably records the Local
    `roots.id` at entry; secondary-list position has no semantic meaning. The
    queue tail carries that id plus resolved primary and secondary root objects,
    so an overlapping hand-off can promote the remembered Local root without
    using stale render state or writing an incomplete binding. A reconciliation
    failure rejects before enqueueing. Hand-off promotes the tracked Local root
    when it has a complete roots row; a disconnected tracked root is logged and
    refused, while legacy partial state with no tracked Local root clears checkout
    mode, warns/toasts that the folder did not follow, and keeps its current
    primary. The repository read sanitizer preserves that legacy worktree shape
    without weakening the complete-metadata requirement for new writes. Every
    checkout-mode transition atomically strips `checkoutBranch`;
    the Local transition also removes both worktree keys and
    `checkoutLocalRootId`, so no stale checkout authority survives the hand-off.
  - The Worktree Map tab (BST-1392, `packages/app-shell/src/worktree-map/`)
    is capability-gated the same way Changes/Canvas/Terminal are:
    `apps/desktop/src/renderer/components/root-layout-content.tsx` resolves
    `isWorktreesBridgeAvailable()` once via `useMemo` and conditionally spreads
    `worktreeMapPageContent` into `buildWorkspaceApps`, never an `isElectron()`
    check — web omits the tab entirely (no `window.worktrees`, no registration).
    Its `onNewThread`/`onHandOffToLocal` handlers do NOT write checkout
    metadata directly: they call
    `useWorktreeCheckoutIntentStore().publish({branch, path, threadId,
    worktreeId})`, a ONE-SHOT request the intent-consumer
    (`use-workspace-bar-mode.ts`) applies to the SELECTED thread exactly once —
    `consume(threadId)` clears the entry so a re-render cannot re-apply it —
    by calling the SAME `onSelectWorktree`/`onHandOffToLocal` callbacks the
    Mode chip's own picker and create-sheet call. `use-thread-checkout.ts`
    remains the ONLY writer of `mastra_threads.metadata.checkout*`; the intent
    store is a cross-component REQUEST queue, never a second write path. A
    failed apply surfaces through the same `logger.error` + toast path the
    chip uses and is not retried.
  - Recents come from main's `recentRootsList` ledger
    (`apps/desktop/src/ipc-domains/workspace-recent-roots.ts`, read through
    `fs:listRecentRoots`), minus folders already mounted in this workspace.
    Every supported flow that may write the ledger through the shared file-system
    instance increments its `recentRootsRevision`, including grants, startup
    multi-root restore, and restore-access registration; the workspace bar reloads
    the ledger from that canonical signal, so Explorer Add Folder and future grant
    or restore callers need no bar-specific refresh wiring. The signal is an honest
    superset: managed-worktree mounts may also increment it because the renderer's
    descriptor does not expose main's grant source, while main deliberately keeps
    managed worktrees out of Recents. Recents loads use a monotonic request generation,
    and an older overlapping response cannot replace a newer snapshot.
    `fs:addRootByPath` has TWO ordered gates: first that ledger (BST-1395), then
    the server-owned managed-worktree authorizer (BST-1390, spec §6.2; widened
    in the BST-1392 follow-up), which requires a live ledger row plus
    reachability per adoption's `assertReachable` rule (managed-directory
    containment, or in-granted-root containment per a forced-fresh inventory)
    and fails closed on every authorizer error. A recents-ledger grant is re-recorded; a managed
    worktree grant is not recorded into Recents at grant time, and `restoreRoots`
    now batch-reads persisted root kinds and skips `kind='worktree'` entries on
    relaunch (BST-1390 Task 10), so that suppression survives relaunch when the
    kind query succeeds and the row exists; it deliberately fails open to ordinary
    Recents behavior if the kind query throws or the root row was never written. Thus **the BAR** cannot
    mount an arbitrary path: a stray or stale path string is rejected. This is
    a hardening boundary against a compromised renderer by itself: the ledger
    remains one input to the main-owned mount decision, never a replacement for
    that decision. BST-1401 additionally rejects renderer mutation of
    `rootsList`, `recentRootsList`, their quarantine records, `notesVaultRoots`,
    and `lastFolderPath` through `storage:setItem`, `storage:removeItem`, and
    `storage:clear`. Desktop E2E uses a separately registered test-mode-only
    seed channel; production never registers it. Paths are keyed with a stripped
    trailing separator, so `/ws/alpha/` and `/ws/alpha` are one slot. A CORRUPT
    ledger is quarantined to `recentRootsList.corrupt`, logged at ERROR, and
    reset (mirroring `readStoredRootsOrQuarantine`) rather than left permanently
    unrecoverable; until the next grant re-populates it, `addRootByPath` rejects
    with the normal "never granted" remedy. The cap (`RECENT_ROOTS_LIMIT`, 50)
    is storage hygiene, deliberately far above realistic mount counts so
    connected roots cannot evict disconnected grants. Desktop-only — web has no
    ledger and therefore no `onAddRecent` affordance (capability gating, not an
    `isElectron()` check).
  - **Finder folder drop (BST-1393, spec §4.1 [D7]) — the bar's THIRD add
    gesture**, alongside Add folder… and Add recent…, and the only one that
    routes through the desktop `window.workspace` bridge rather than
    `@brainstrike/file-explorer-ui/shell`'s `useFileSystem()` directly.
    - **`useConnectFolder` (`workspace-connect/use-connect-folder.tsx`) is the
      ONE seam every W6 entry point converges on**: File menu, `brainstrike
      <path>` argv, macOS `open-file`, `second-instance` argv, File ▸ Open
      Recent, AND a Finder drop — five `WorkspaceOpenOrigin` values (`argv` ·
      `open-file` · `second-instance` · `menu-recent` · `drop`), all logged on
      refusal so a "why did this folder mount / not mount" question always
      names its real gesture. **Security posture (ruling S1): a path from any
      of these is a REQUEST, never a grant.** `open-file` and argv are
      attacker-influencable (any process can run `open -a BrainStrike
      <path>`), so `connectPath` calls the SAME picker-less `addRootDirectoryByPath`
      Add Recent uses (never a new grant door) and renders the SAME
      "never granted, use Add folder…" remedy toast on refusal. `connectPath`
      resolves to the mounted `DirectoryHandle` on success and `null` on
      every refusal/failure path (each already toasted here) — a caller that
      needs to react to success, rather than just fire-and-forget like
      `workspace-connect-host.tsx` does for the other four origins, can.
    - **`extractDroppedFolderPaths` (`workspace-connect/extract-dropped-folder-paths.ts`)**
      turns a drop's `DataTransferItem`s into absolute paths, synchronously:
      a `DataTransferItem` goes invalid the instant the drop event settles
      (the same contract `packages/notes-vault/src/core/drop.ts` established),
      so `webkitGetAsEntry()`/`getAsFile()` must both run inside the drop
      tick. Files vs. folders are told apart by ASKING THE DOM
      (`entry.isDirectory`), never guessed from `size`/`type` and never
      forwarded blind to `connectPath` (ruling D1) — a plain file sent there
      would come back with a GRANTS-flavored refusal that misdescribes the
      problem. Every non-outcome is counted, not swallowed, in three SEPARATE
      buckets so the notice never names the wrong noun: `skippedFileCount`
      (confirmed plain files), `unreadableCount` (items whose kind
      `webkitGetAsEntry()` threw before revealing — never confirmed to BE a
      folder), and `unresolvedCount` (confirmed folders whose `File` yielded
      no disk path). Resolved paths are deduped in drop order.
    - **`WorkspaceBarDropZone` (`packages/assistant-ui/src/workspace-bar/`)**
      wraps the bar's existing chips ONLY when `onDropItems` is supplied
      (app-shell's `useFolderDrop` decides that from the bridge + `connectPath`
      capabilities) — no wrapper, no ring, no listeners on web. The `'Files'`
      MIME-type gate (`dragCarriesFiles`, checked BEFORE `preventDefault()`)
      is byte-identical to `notes-vault-panel.tsx`'s copy of the same name —
      intentionally not shared into a module for one function, but both sites
      carry a cross-reference comment because that gate is the
      security-relevant part of both surfaces (it is what keeps an internal
      pragmatic-drag-and-drop thread-tab drag from being consumed): if one
      copy is ever hardened, check the other. The drag-leave ring guard reads
      `event.relatedTarget` rather than the vault panel's
      `currentTarget === target` check: that check only holds up because the
      vault panel's drop surface has few children, but the bar is full of
      chips, and a dragleave bubbling off any one of them would otherwise
      flicker the ring. The wrapper is a bare `<div>` with TWO a11y
      suppressions, deliberately not a labelled `<section>`/landmark: chips
      already carry their own accessible names, this exact bar already
      rejects an extra grouping level for that reason (see the composer bar's
      own container comment, `workspace-bar.tsx`), and the wrapper exists
      only to catch a pointer gesture AT users cannot perform — the keyboard
      path is the Folder chip's Add folder… action.
    - **`useFolderDrop` (`workspace-connect/use-folder-drop.ts`) chains the
      SAME thread-attachment step Add folder…/Add recent… run after their own
      successful mount** (`recordAddedAsSecondary`, injected in from
      `use-workspace-bar.ts` since this hook has no thread/database context
      of its own) — a review finding: routing a drop through `connectPath`
      alone mounts the folder globally but leaves the bar showing no trace of
      it, on either outcome. Multiple dropped folders connect ONE AT A TIME,
      not concurrently: `addRootDirectoryByPath` shares a loading flag and a
      "most recently mounted becomes focused" outcome across calls, so firing
      them concurrently makes both non-deterministic (order stops matching
      drop order). A refused connect (`connectPath` resolves `null`) records
      nothing and chains no `recordAddedAsSecondary` call — `connectPath`
      already toasted its own refusal reason, so nothing here fires a second,
      differently-flavored notice on top of it. A drop that mounted
      everything cleanly toasts NOTHING, matching Add folder/Add recent's own
      silence on success — the chip appearing IS the feedback.
  - Reveal: the chip NEVER hardcodes an OS name. `WorkspaceBarProps.reveal`
    pairs `{ label, onReveal }` so supplying a handler without a label is a
    type error, and app-shell feeds it the platform-aware `revealLabel()`
    exported from `@brainstrike/file-explorer-ui/context-actions`.
  - Branch chip: `window.git.status` supplies the primary root's
    branch/detached, ahead/behind, and dirty-dot state — no polling. The dot's
    checkout-status read refetches on BOTH live-refresh signals: every accepted
    `changes:invalidated` git-metadata push AND the primary root's own git-scope
    nonce (`selectGitScopeRefreshNonce`), which is what carries WORKING-TREE
    edits. Metadata pushes report topology only, so on that nonce alone the
    dirty dot went stale the moment a file changed without a branch operation.
    The interactive menu also reads `window.git.repository` and its own
    `window.git.status`, then reuses the Git workbench's
    `buildBranchSwitchModel`: local branches stay in repository recency order,
    the current branch remains identified, and a branch held by another
    worktree shows `Worktree: <name>` and an explicit disabled reason. The
    shared switch gate derives dirty state only from tracked porcelain entries,
    so an untracked-only checkout remains switchable while staged or modified
    tracked files disable direct switching. The chip's dirty dot still reflects
    all porcelain entries. A disabled dirty row offers a separate `Switch in a
    new worktree` menu item only when `onSwitchInNewWorktree` is supplied; the
    later W3 Mode-Chip/worktree-service layer will supply that optional
    capability. Until then app-shell omits the callback, so the disabled reason
    stands alone with no worktree action. Direct switching and branch creation
    call the existing `switchBranch` / `createBranch` bridge paths without a
    fresh client-side status pre-check; the bridge result is the source of truth,
    and a returned or thrown mutation failure is logged and surfaced as a
    destructive toast. Fetch is offered only for a discovered default remote,
    and the call names that remote explicitly rather than relying on git's
    default. After a successful mutation, the hook
    refreshes the git inventory and advances its own reload nonce so it re-reads
    repository and status topology. Unlike the dot, the switcher's own
    repository/status load is keyed only on `anyInvalidationNonce` plus that
    post-mutation reload nonce — NOT on the root's git-scope nonce. An external
    working-tree edit to a tracked file can therefore leave the switch gate's
    tracked-dirty read stale until the next metadata push or successful
    mutation. The load is self-contained (BST-1452 M2): it fires its own
    `window.git.status` read unconditionally, concurrently with the
    workspace-bar dot's independent status read, rather than waiting on that
    other hook to resolve first. When that status read reports a non-repository
    primary root, the switcher stops there — it performs the status probe
    only, issues no `window.git.repository` read, and logs no warning, since
    "this folder isn't a repository" is an expected outcome, not a failure.
    There is no empty-list fallback: a failed menu repository/status
    read is logged and leaves the status chip non-interactive. The chip remains
    desktop-only and is absent for a non-repository root or a failed checkout-
    status read; that failure is logged and NEVER rendered as "clean". It is
    withheld whenever `primaryRoot` is absent, so a branch never renders with
    no folder beside it. Both live-refresh signals depend on the main-process
    git inventory having ARMED a watcher for that root's repository, which only
    happens inside an inventory build — so roots registered after app-ready are
    nudged into discovery by `use-roots-reconciliation.ts` calling
    `changes.inventory({ maxAgeMs: 0 })` once per registration (BST-1397; see
    "Discovery refresh on root registration" in
    `docs/agents/changeset-diff.md` § REFRESH SEAMS). The forced option is what
    makes the nudge reliable: it guarantees a build that started after the
    registration, so the TTL cache and in-flight coalescing cannot serve back a
    snapshot that predates the new `roots` row. Without that nudge a mid-session
    Add Folder / Recents root gets no metadata push at all and the chip only
    updates on reload.

