# Worktree roots and the Mode chip — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED".
Read before changing `roots.kind = 'worktree'` classification, the managed-worktree mount authorizer, or the Local/Worktree Mode chip (BST-1390, BST-1392).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

- **`roots.kind = 'worktree'` (BST-1390).** A root mounted for a BrainStrike-
  managed worktree carries its own kind, set at INSERT by `reconcileRoots` from
  the ledger-only `window.worktrees.listManagedPaths()` path set. This boot-
  critical read never builds git inventory or resolves workspace-root joins.
  Until the first successful desktop ledger read, reconciliation updates
  existing rows but defers new inserts so a transient bridge failure cannot
  durably misclassify a managed worktree as `path`.
  `kind` is never modified on an existing row, so a worktree root registered
  before W3 keeps its old kind — visible, not silently rewritten. The DB
  column has a real CHECK constraint (migration 039, widened by migration 111
  to add `'worktree'`) — this is NOT type-level-only, unlike an earlier draft
  of this plan assumed. Background indexing defaults to OFF for this kind
  [D8] (see `defaultBackgroundIndexingEnabled` in
  `packages/app-state/src/stores/background-indexing-preferences-store.ts`,
  consumed by the one sync-target filter in
  `workspace-collection-sync-provider.tsx`) until the hash-reuse cost is
  measured against the BST-393 benchmark. The Explorer root surfaces (forest
  root headers and the single-root status row) and the workspace-root status
  popover surface this as `Not indexed`, explain that
  managed worktrees are excluded by default to avoid duplicate corpus
  indexing, and offer a per-root opt-in. The durable DB root id keys that
  persisted preference; the adapter root id keys only the transient mounted-
  root status consumed by those UI surfaces. Opting one root in never changes
  another worktree or suppresses eligible non-worktree roots. If every mounted
  root is excluded, the sync status remains visibly `waiting` with the same
  explanation rather than silently publishing no work. A mounted root with a
  durable id but no published kind is deferred from the current sync pass;
  publishing its reactive kind map restarts the pass, so mid-session Add Folder
  cannot race the D8 exclusion.
- **The second (and last) sanctioned picker-less mount.** `fs:addRootByPath`
  now accepts a path authorized by EITHER the recent-roots ledger (BST-1395)
  OR the managed-worktree authorizer (BST-1390, widened in the BST-1392
  follow-up): a live `brainstrike_worktrees` row whose realpath is REACHABLE by
  the same rule adoption's `assertReachable` applies — under the realpath'd
  managed directory, or inside a granted workspace root per a FORCED-FRESH
  inventory's containment (a `roots` write never dirties the cached snapshot,
  so a default cached read could honor a just-closed root; the shared
  `isReachableCheckout` predicate in `worktree-adopt.ts` backs BOTH
  `assertReachable` and `isAuthorizedWorktreeMountPath`, so the two rules
  cannot drift). An unavailable inventory refuses only the in-root arm, at
  WARN — the managed-directory arm is inventory-free. An outside-roots row —
  e.g. its granting root was disconnected after
  adoption — stays refused; a ledger row alone is never a mount grant. The
  ledger is checked first so a broken authorizer cannot take the recents path
  down with it. Managed worktrees are deliberately NOT written into `recentRootsList` at
  grant time — that list is the user's folders, not the app's scratch
  directories — and (BST-1390 Task 10) `restoreRoots` now also skips recording
  a `kind='worktree'` entry into recents on relaunch, closing the leak the
  grant-time suppression alone left open across a restart. **BST-1393 (W6)
  added four new CALLERS of this path (File ▸ Open Recent, argv/`second-instance`,
  macOS `open-file`, and the composer folder drop) and NO new authorization:
  each is a request that these same two gates still decide, and a refusal is
  surfaced with the picker as its remedy.**

  - **Mode chip (W3, BST-1390): Local / Worktree [D1].** Local means the
    thread works in the primary root's own checkout; Worktree means an
    isolated linked worktree BrainStrike created, recorded in
    `brainstrike_worktrees`, mounted as a `kind='worktree'` root through the
    managed-worktree grant (see `roots.kind = 'worktree'` above), and bound as
    the thread's PRIMARY through the same `operatingRoot*` metadata triple
    `persistThreadRootBinding` writes — which is what makes the server's
    existing `boundWorkspaceRootId`-first ordering
    (`orderWorkspaceRootsForRuntime`) resolve hooks, tools and the terminal
    into the worktree with NO server change. "Cloud" is deliberately omitted,
    not stubbed — there is no environment story to explain. A non-repository
    primary root gets a DISABLED chip stating "Not a git repository", never an
    absent one (`packages/app-shell/src/hooks/use-worktree-mode.ts`). The
    chip's own list of worktrees comes from the `window.worktrees` bridge's
    `list()` (the ledger + a live `git worktree list` merge in
    `apps/desktop/src/assistant-server/worktree-service.ts`), NOT from
    `window.git` inventory, so it refreshes independently of the Branch
    chip's git-status read above — eagerly on mount, and again after every
    create/select/archive mutation. The existing-worktree picker
    (`worktree-picker-dialog.tsx`) lists EVERY worktree the ledger reports —
    including ones another tool created (`~/.codex/worktrees`,
    `~/.cursor/worktrees`), labelled by tool — each usable or disabled with
    its reason and, where remediable, a "Grant access…" button that opens the
    OS folder picker. "New worktree…" opens a create sheet
    (`worktree-create-dialog.tsx`) with a read-only Location, a `bs/<name>`
    branch default (editable, or "Detached — name the branch later"), and a
    Setup summary; a creation failure renders IN the sheet and leaves the
    thread on Local rather than partially switching it. Both dialogs are
    written INSIDE `ModeChip`'s own JSX rather than hoisted, so their
    `<Dialog>` nesting depth stays 1 and their panel paints at `z-[51]`
    (`packages/ui/src/layers.ts`) — above nothing else the chip owns, since
    the dropdown menu that opens them (`z-[70]`, `POPUP_LAYER_CLASS`) has
    already closed by the time either one mounts. **Live-verified gap
    (BST-1390, not yet filed as its own follow-up):** closing either dialog
    with Escape leaves focus on `document.body` rather than returning it to
    the Mode chip trigger — confirmed against the running app, not assumed;
    fix or file before relying on keyboard flow through this chip.

