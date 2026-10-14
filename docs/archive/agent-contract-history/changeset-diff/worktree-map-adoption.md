# Worktree Map, adoption, and mount ordering — evidence

Supports `docs/agents/changeset-diff.md` § "WORKTREE MAP + ADOPTION".
Read before changing adoption reachability, the primary-row gate, collection navigation, responsive rows, or the mount-vs-ledger refresh split.

The lines below are the pre-distillation contract text, extracted verbatim.

`WorktreeListEntry` carries `primary`, `repoCommonDir` and `createdAt` so one
`worktrees.list()` can drive both the Mode chip's picker and the Worktree Map.
`primary` is `descriptor.path === repository.identity.repositoryRoot`; a primary
row is deliberately `usable: false` with a stated reason, because a thread that
operates in the user's own clone is in LOCAL mode by definition and binding
`checkoutMode: 'worktree'` to it would produce a checkout hand-off could not
leave. `repoCommonDir` — not `repositoryRoot` — is the key `brainstrike_forge_prs`
joins on, so the Map's PR pill and the thread list's PR pill cannot disagree.

`worktrees.adopt` records an EXISTING on-disk worktree in the ledger. It refuses
a path that is outside every granted root AND outside the managed directory:
`resolveUsability` treats "has a ledger row" as authorization, so an
unreachable adopted row would read `usable: true` while every operation on it
failed. It also refuses the repository's own primary checkout, mirroring the
picker's primary gate. `base_ref` is the worktree's HEAD at adoption time —
"unpushed" for an adopted worktree means "committed here since BrainStrike
started managing it". The Mode chip's picker never calls it — every unmanaged
row is `usable: false`, so its select button is always disabled, which makes
adopting through the picker structurally unreachable. The Worktree Map card's
`Adopt` action is the only UI caller; the agent tool is the only other one.

`worktrees.checkoutStatus` is a LAZY, per-checkout `git status --porcelain=v2
--branch -z` parsed by the production `parsePorcelainV2Z`. It is deliberately
not folded into `list()`, which backs the picker and refreshes on every
invalidation; N status subprocesses behind an orientation surface is the cost
this seam exists to avoid. Until a card's status resolves it renders
"checking…", never a clean glyph.

**Collection navigation (BST-1635).** The Map projects its canonical repository
models through `selectWorktreeCollection`: tokenized case-insensitive local
search, All/Running/Needs attention/External filters, primary-first name or
recent-activity sorting within each repository, and a global 25-checkout page
bound. Search/filter/sort changes return to the first page; a smaller result
clamps both the visible and source page so recovering async results cannot jump back.
Page changes remount the results scrollport, including automatic clamping; toolbar
changes also reset checkout scrolling. These are ephemeral React view preferences, never a
new persistent store or another DB/IPC query. Unknown/loading status is not an
attention signal; the primary checkout's Local-only usability is not a fault.
Status errors, dirty/behind checkouts, failed PR checks and unusable non-primary
checkouts are attention signals. Repository and status loading/refresh ownership
stay in `useWorktreeMap`. The paired collection cases live in
`worktree-map-model.test.ts` and `worktree-map-surface.test.tsx`.

**Responsive rows (BST-1636).** Repository sections use one vertical scrollport
and full-width checkout articles, with one, two, or four columns based on the
Worktrees container width (600px / 760px). Checkout identity/path, Git status,
thread activity and actions keep a stable order. The action group uses 32px
controls and stays inside the row at narrow widths; the primary label may
truncate while its accessible name and title remain complete. The indexing toggle exposes its existing exact-root preference via
an accessible name and `aria-pressed`. Missing-on-disk rows do not claim a
pending Git read. A resolved clean status is explicit, and the selected linked
thread is labeled and accented. Disabled-target guidance stays visible in a neutral tone; the canonical unmanaged-checkout message directs users to the shipped Worktrees → Adopt action. All mutation and capability guards are unchanged.
Paired behavior coverage remains in `worktree-map-surface.test.tsx`; the real
large-collection/geometry regression is in
`apps/desktop/e2e/worktree-map.desktop.test.ts`. The opt-in
`scripts/probe-worktree-map.mjs` checks row fit instead of horizontal scrolling.

Mounting is a SEPARATE step from adoption and does not happen automatically:
adopting a worktree only inserts the `brainstrike_worktrees` ledger row, it
does not add a `roots` row. The picker-less mount grant matches adoption's own
reachability rule (BST-1392 follow-up): a live ledger row that is under the
managed directory OR inside a granted root (per a forced-fresh inventory)
mounts without a picker (`isAuthorizedWorktreeMountPath`; the shared
`isReachableCheckout` predicate in `worktree-adopt.ts` backs it and
`assertReachable` both, so the two rules cannot drift) — before the widening, an
adopted in-root checkout outside the managed directory (the
`.claude/worktrees/<name>` shape) adopted fine and then refused to mount. An
outside-roots row stays refused. The Map's `onNewThread` mounts the checkout via
`addRootDirectoryByPath` before binding a thread, mirroring the ordering
`use-worktree-mode.ts`'s `mountWorktree`/`onSelectExisting` already use for the
Mode chip's create/pick flows (found live during the W5 CDT pass: without this
ordering, the bind's `resolveRootIdAfterReconciliation` retry — 20 × 250ms,
already generous — always exhausted, because nothing else ever creates the
`roots` row for a freshly-adopted worktree). The Map never re-reads on its own,
so every mutation that changes what a card resolves needs a matching re-read —
but the two mutation classes get DIFFERENT mechanisms (settled in PR #2671
review; the W5 CDT pass filed the staleness, #2671 closed it):

- **Ledger mutations** (`onAdopt`, `onArchive`) call `refresh()` on the Map's
  own card list on success — their IPC resolves only after the ledger write, so
  the refresh observes a completed write. A refusal never refreshes.
- **Mount paths** (`onNewThread`'s mount-before-bind, `onAddAsRoot`) must NOT
  call `refresh()`: `addRootDirectoryByPath` resolving does not mean the
  `roots` row (which `rootId` and therefore `indexing` resolve from) exists —
  the row is written later by the fire-and-forget mid-session registration
  (`performRootRegistration`), whose completion emits no `changes:invalidated`,
  so a caller-side refresh races the write and re-reads `rootId: null`.
  Instead `useWorktreeMap` keys its load effect on the `useOptionalRootIdentity`
  context value, which `RootIdentityProvider` re-memoizes exactly when a new
  adapter→DB mapping publishes (i.e. after `reconcileRoots` wrote the row) —
  deterministic, poll-free, and it covers mounts started from ANY surface
  (Mode chip included), not just the Map's own actions.

Both halves are pinned: the surface test pins that mount callbacks never call
`refresh()` (and that adopt/archive do), and the `use-worktree-map` test pins
the identity-driven re-read plus its cheapness (no extra per-card `git status`).
