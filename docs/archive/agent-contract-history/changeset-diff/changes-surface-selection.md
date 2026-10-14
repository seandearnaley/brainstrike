# Changes surface resolution root and selection keys — evidence

Supports `docs/agents/changeset-diff.md` § "Changes surface (`packages/app-shell/src/changes/`)".
Read before changing resolution-root selection, `changedFileKey`, empty-selection semantics, or the diff card's sizing props.

The lines below are the pre-distillation contract text, extracted verbatim.

Lazy-mounted workspace-panel tab (capability-gated: absent unless
`window.changes` is present, no `isElectron()`). `ChangesSurface`
(`ui/changes-surface.tsx`) composes `ChangesetHeader` (source picker),
`ChangedFilesTree` (canonical `TreeTable`, root → repo → worktree →
file), and `ChangesetDiffPane` (stacked `ChangesetFileDiffCard`s).

**Resolution root for a `git-scope` changeset is the workspace root
CONTAINING its worktree**, per the inventory's `WorktreeDescriptor.containment`
— NOT the surface's single focused root:

```ts
function resolveGitScopeResolutionRootId(changeset, inventory) {
  // find the repository/worktree matching changeset.repositoryRoot/worktreePath
  return worktree.containment === 'outside-roots' ? null : (worktree.containment[0] ?? null);
}
```

In a multi-root workspace the source picker offers scopes for worktrees
under every mounted root, but the main-process containment check
(`resolveContainedWorktreeCwd`) deterministically fails
(`outside-roots-unsupported:`) unless resolution uses a root that actually
contains the worktree (BST-1114 PR #2274 review finding). `null` when the
worktree can't be found or has no containing root — `useChangeset` stays
inert (no fetch) rather than guessing.

**Selection semantics** (`changes-store.ts`, module-level Zustand
singleton shared between the Changes surface and the git panel's Changes
tab — see below): an **empty** `selectedFileKeys` means "no explicit
selection — render every file in the changeset", not "render nothing"; a
changeset with genuinely no files is a different fact reported by
`ChangesetView.files`. `hasExplicitSelection` exists so callers state
which of the two they mean rather than re-deriving `.size > 0`.
`changedFileKey` is keyed on `(rootId, worktreePath, path)`, NUL-joined:

```ts
export function changedFileKey(entry: ChangedFileEntry): string {
  return `${entry.rootId ?? ''}\u0000${entry.worktreePath ?? ''}\u0000${entry.path}`;
}
```

`path` alone collapses across two worktrees of the same repo;
`worktreePath` is `null` for every snapshot-sourced entry, so `rootId`
distinguishes those (two roots can share a relative path). Guarded by
`changes-store.test.ts`'s `'renders every file when nothing is explicitly
selected'` (asserts `selectRenderedFiles` returns the SAME array
reference on an empty selection) and its `changedFileKey` composite-key
cases.

`ChangesetFileDiffCard` (`ui/changeset-file-diff-card.tsx`) is the shared,
prop-driven diff-rendering leaf (own lazy `IntersectionObserver`-gated
load, own generation-guarded staleness protection). Its content branches:
`binary` → a dedicated explanatory card; `full`/`hunks-only` → the shared
`DiffView` via the `{ kind: 'structured', diff }` source (`null`
additions/deletions render as `"—"`, never `"0"`); any error → the real
message plus a per-card Retry. The former `journal-content-expired:`
explanatory card was REMOVED in T4 (snapshot-backed changesets never evict
content, so the state is unreachable) — its absence is pinned by
`changeset-file-diff-card.test.tsx`.
It has two additive optional props: `bodyClassName` (default `'h-[420px]
min-h-0'`, the sizing tuned for the surface's vertically-stacked multi-file
pane) and `className` on the card ROOT (default `undefined`, i.e. the
surface's original markup). A single-card host needs BOTH — the git panel
passes `className='flex min-h-0 flex-1 flex-col'` +
`bodyClassName='min-h-0 flex-1'`. `bodyClassName='h-full'` alone does
nothing: the card root is an auto-height block, so a percentage height
resolves to `auto` against it and the diff sizes to its own content
(measured, not assumed) instead of filling the pane — which also defeats
`DiffView`'s internal scroller, whose CodeMirror theme pins `.cm-editor`
to `height: 100%`.
