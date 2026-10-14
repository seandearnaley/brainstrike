# Per-mode git plumbing, caps, rename parity — evidence

Supports `docs/agents/changeset-diff.md` § "Diff engine — `apps/desktop/src/assistant-server/git-structured-diff.ts` (+ `git-structured-diff-refs.ts`)".
Read before changing a mode's compared sides, the content caps, the hunks-only classification, or rename pairing.

The lines below are the pre-distillation contract text, extracted verbatim.

`createStructuredDiffOps({ cwd, invoke, invokeHookFree })` returns
`structuredFileDiff(params: StructuredFileDiffParams) =>
Promise<GitResult<StructuredFileDiff>>`. No Electron imports; every git
failure resolves to `{ ok: false, error }`, never a throw across the IPC
boundary.

Per-mode git plumbing (all via the CWD-relative `:./<path>` magic pathspec
and `--relative`, not the repo-root-relative default — see the file's own
PATH SPACE doc comment for the empirically-verified reasons):

| mode | old side | new side | numstat target |
| --- | --- | --- | --- |
| `working` | `HEAD:./<path>` | live worktree file | `['HEAD']` |
| `staged` | `HEAD:./<path>` | index, `:0:./<path>` | `['--cached']` |
| `unstaged` | index, `:0:./<path>` | live worktree file | `[]` |
| `untracked` | none | live worktree file (off disk, no git invocation on the happy path) | n/a |
| `commit` | `resolveCommitOldRef` (`<commitId>^`, or the empty-tree object id for a root commit) | `commitId` | two-ref numstat |
| `range` | caller-resolved `baseRef` | literal `'HEAD'` | two-ref numstat |

`unstaged`'s old side is the **index**, not HEAD — added because the
`unstaged` git-scope's own file LISTING (`changeset-git-scope.ts`'s
`listRefComparisonChanges(invoke, [])`) is index-vs-worktree; before this
mode existed, `unstaged` mapped its per-file diff to `working`
(HEAD-vs-worktree), so a file with both staged and unstaged edits reported
contradictory numbers between the list and the rendered diff (BST-1113
review finding). Guarded by
`apps/desktop/src/__tests__/assistant-server/git-service-structured-diff.test.ts`
`'reads the OLD side from the INDEX (:0:./<path>), never HEAD — the
review-fixed bug'`.

**Caps.** `STRUCTURED_DIFF_CONTENT_CAP_BYTES = 2 * 1024 * 1024` (2MB,
per-side full-content cap, nominal parity with the edit-checkpoint
journal's `MAX_WRITE_WORKSPACE_FILE_BYTES = 2_000_000` — NOT byte-identical
today, the two should move together if either is revisited). A side is
size-PROBED (`cat-file -s`) before any read, so an over-cap side's bytes
are never actually read. The shared `boundOutput` ceiling
(`GIT_MAX_OUTPUT_BYTES = 1_000_000`, `git-service.ts`) truncates any
oversized diff/status output at a clean boundary with a visible marker;
`GIT_MAX_BUFFER_BYTES = GIT_MAX_OUTPUT_BYTES * 4` is the hard `execFile`
capture ceiling — a `maxBuffer` overflow on an actual blob READ is a hard
failure, never a truncated success (distinct from an overflow on the DIFF
invocation, which degrades to `hunks-only`).

The four `hunks-only` reasons are decided by two pure functions in
`git-structured-diff.ts`:

```ts
function classifyOverCapReason(oldOverCap, newOverCap) {
  if (oldOverCap && newOverCap) return 'over-cap-both';
  return oldOverCap ? 'over-cap-old' : 'over-cap-new';
}
function resolveOverCapReason(oldOverCap, newOverCap) {
  if (oldOverCap || newOverCap) return classifyOverCapReason(oldOverCap, newOverCap);
  return 'diff-overflow';
}
```

`'diff-overflow'` fires when the unified-diff invocation itself hit
`maxBuffer` while NEITHER side individually exceeded the per-file cap
(many small scattered edits across two large-but-under-cap files);
`'over-cap-*'` fires per which side(s) exceeded the cap. Binary detection
is a null-byte check on an actually-read side (`Buffer.includes(0)`),
checked FIRST and winning whenever either side was read and found
binary — an over-cap side (never read) can never block a confirmed-binary
call from the other side. Guarded by
`git-service-structured-diff.test.ts`'s `describe`s `'structuredFileDiff —
cap boundary'`, `'... a maxBuffer overflow on the diff invocation forces
hunks-only'`, and `'... binary detection via stdoutBuffer null byte'`.

**Rename parity.** `commit`/`range`/`staged`'s numstat runs
`--find-renames` scoped `-- .` (the WHOLE opened root), never `-- <path>` —
gitdiffcore(7)'s pathspec limiting happens BEFORE rename pairing, so a
pathspec naming only the new path could never pair with its old name. The
matching numstat entry's `oldPath` then feeds both the old-side blob spec
and the unified-diff pathspecs. Proven end-to-end for `staged` mode by
`'routes the old-side read through oldPath, not the current path'`
(`git-service-structured-diff.test.ts`); `commit`/`range` share the
identical mechanism via `structuredRefDiff` with no separate rename
codepath to diverge (confirmed by reading `structuredRefDiff`, not
assumed).

`git-structured-diff-refs.ts` adds ref-injection-safety validation
(`validateCommitId`/`validateBaseRef` — non-empty, no whitespace, no `:`,
no leading `-`; `commitId` additionally the full 40–64 hex object-id shape)
and the root-commit empty-tree fallback (`resolveCommitOldRef`, via `git
rev-list --parents`). For a MERGE commit, `commit` mode's `^` is the FIRST
parent (first-parent diff, matching `git-history.ts`'s `commitDiff`
precedent).
