# Git panel convergence and canvas navigation — evidence

Supports `docs/agents/changeset-diff.md` § "Git panel (`packages/app-shell/src/git-panel/`) — converged in W6".
Read before proposing to compose the panel's staging list onto `ChangedFilesTree`, or before changing per-row scope pinning, History staleness, or the workbench header's trust gating.

The lines below are the pre-distillation contract text, extracted verbatim.

> **Correction, verified 2026-09-21.** The contract's neighbouring
> "`DiffView`'s `strings` source" section named
> `assistant-tool-approval-notice.tsx` as the last `strings` consumer. That
> file is 37 lines and imports no diff view. The sole remaining production
> consumer is `packages/assistant-ui/src/approval-preview.tsx`, which passes
> `original`/`modified` to `DiffView` (resolved as `sourceKind: 'strings'` by
> `packages/ui/src/diff-view/diff-view-source.ts`).

Two tabs: Changes (`git-changes-view.tsx`) and History
(`git-history-view.tsx`); both now resolve diffs through the structured
engine and render `ChangesetFileDiffCard`. `git-diff-surface.tsx` and
`packages/ui/src/diff-view/parse-unified-diff.ts` are **deleted** — `git
grep parseUnifiedDiff` finds zero code references, only historical mentions
in doc comments and planning docs.

**Staging composition is a settled, do-not-relitigate ruling** (recorded
verbatim in `git-changes-view.tsx`'s top doc comment): the panel's left
staged/unstaged/untracked list, its per-row stage/unstage buttons, and the
tri-state stage-all control stay **panel-owned**, still driven straight
off `window.git`'s `GitStatus.files` — the panel does NOT compose onto the
shared `ChangedFilesTree`. Two reasons: (1) `ChangedFilesTree`'s checkboxes
mean "which files' diffs to render", a different semantic from this
panel's tri-state, which means "which INDEX a stage/unstage action
targets"; (2) `changes-store.ts` is the module-level singleton described
above, shared with the Changes surface tab which can be mounted
simultaneously — writing the panel's selection into `selectedFileKeys`
would silently clobber the Changes surface's own selection and vice versa.
The panel therefore never imports `changes-store.ts` and never mounts
`ChangesetDiffPane` (which reads that store internally); it mounts
`ChangesetFileDiffCard` directly instead — a fully prop-driven leaf with
no store coupling.

**Per-row scope pinning**: a `git-scope` changeset carries exactly one
`GitScope`, so the panel re-pins the changeset to the selected row's own
bucket on every selection change — staged → `{ kind: 'staged' }`, unstaged
→ `{ kind: 'unstaged' }`, untracked → `{ kind: 'uncommitted' }`
(untracked's only route, per the engine mapping above).

**History tab**: `CommitFilesSidebar` (commit-files listing) is
unchanged — still `bridge.commitFiles`, its own request-generation
staleness guard. The diff pane calls `useGitPanel.loadCommitFileDiff`,
which calls `bridge.structuredFileDiff(rootId, { commitId, mode: 'commit',
path })` — routed through `window.git`, not `window.changes`, since
`commit` mode is already exposed there (see IPC DOMAIN above).
`ChangesetFileDiffCard` is mounted with `key={`${commitId}:${path}`}`:
selecting a different commit or file remounts a fresh card instance with
its own generation counter, so a slow response for a prior selection lands
on an unmounted component and is dropped by React rather than clobbering
the current card. `use-git-panel.ts`'s `loadDiff` (the old
`parseUnifiedDiff`-backed Changes-tab loader) is removed as dead; no
`loadCommitDiff` export exists either — only `loadCommitFileDiff` /
`loadCommitFiles`. Guarded by `git-panel.test.tsx`'s `'never lets a late
historical diff replace the current commit diff'`.

**Canvas navigation in the changes-navigation store (BST-1173, reshaped by
BST-1258).** `changes-navigation-store` owns the Canvas surface's DOMAIN
navigation facts: `openCanvasPanel()` is the external entry point (same
unconditional-write reasoning as `openChangeset`), and `canvasRefreshNonce` /
`requestCanvasRefresh()` is the Canvas panel's re-resolve trigger — the same
re-resolve-not-push design as `liveRefreshNonce`, bumped by
`use-wrapper-rewind-wiring`'s `handleRunEditActivity` when a completed
edit-activity event's tool name denormalizes to `brainstrike.manageCanvas`
(canvas mutations are edit-risk, so they already ride that stream; the canvas
bump is unthrottled and then falls through to the guarded Changes refresh).
All of these reset with the store's existing factory-reset registration.

WHICH workspace tab is showing moved OUT of this store (BST-1258 unified
workspace tab panel): Changes and Canvas are closable singleton workspace
APP tabs registered by `root-layout-content`'s `ExplorerAppSurface` and owned
by `useWorkspaceTabSelectionStore` (`@brainstrike/file-explorer-ui`), whose
`openApp('changes' | 'canvas')` both `openChangeset`/`openCanvasPanel` call.
The sticky keep-mounted contract (the sandboxed canvas iframe must not reload
on tab switches) is now that store's session-only `mountedAppIds`. The
capability gate is unchanged in spirit and PER-APP: any subset of
{Changes, Canvas} may register; an unregistered app has no tab and no
launcher card. Web passes NO `canvasPanelContent` — nothing can write
`brainstrike_canvas_versions` there (desktop-only tool, no sync) and a
permanently-empty tab would violate the omit-don't-stub convention.

**Worktree dropdown** (`git-workbench-header.tsx`): each entry publishes a
`git-scope` changeset (`scope: { kind: 'uncommitted' }`) via
`useChangesNavigationStore.openChangeset` — which itself opens/activates the
Changes workspace app tab via `useWorkspaceTabSelectionStore.openApp` — and
then switches the SHELL route back to `explorer` via
`usePanelLayoutStore.setActiveTab`, because the Changes surface is a
workspace app tab on that route, not a route of its own. Two distinct
stores, two distinct "tab" concepts; both writes are required. Trust gating, priority-ordered, each disabled state stating its
own reason (never a silent disable):

```ts
if (!available) return { navigable: false, disabledReason: 'Repository inventory is unavailable in this build.' };
if (inventoryError) return { navigable: false, disabledReason: `Repository inventory unavailable: ${inventoryError}` };
if (!inventory) return { navigable: false, disabledReason: 'Loading repository inventory…' };
if (!descriptor) return { navigable: false, disabledReason: 'Not found in the workspace inventory yet.' };
if (descriptor.trust === 'unvalidated') return { navigable: false, disabledReason: descriptor.trustReason ?? '...' };
if (descriptor.containment === 'outside-roots') return { navigable: false, disabledReason: "isn't inside any workspace root…" };
if (worktree.lockedReason !== null) return { navigable: false, disabledReason: `Locked: ${worktree.lockedReason}` };
return { navigable: true, disabledReason: null };
```

The `unvalidated` check precedes the `outside-roots` check deliberately:
`trust: 'unvalidated'` only ever occurs for an outside-roots worktree (see
TRUST RULE above), so it is the strictly narrower case and carries the
more specific, bidirectional-check-derived reason. The `available` check is
first because a bridge-less build reports `inventory: null` with `error:
null`, which would otherwise read as a permanent "Loading…" that never
resolves. Guarded by `git-workbench-header.test.tsx`'s seven gating tests,
one per branch.
