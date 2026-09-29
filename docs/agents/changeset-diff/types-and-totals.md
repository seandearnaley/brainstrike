# Changeset types and totals — evidence

Supports `docs/agents/changeset-diff.md` § "TYPES".
Read before changing the domain union, the totals contract, or `toolAttributed`. The type's own doc comments in `packages/types/src/changeset.ts` remain the first source of truth.

The lines below are the pre-distillation contract text, extracted verbatim.

The domain contract. Its own doc comments are unusually rich and are the
first source of truth — read them before this section.

- **`Changeset`** — discriminated union: `agent-run` (`runId`/`threadId`,
  shadow-git snapshot engine), `run-range` (`fromRunId`/`toRunId?`/`threadId`,
  aggregate across runs), `git-scope` (`repositoryRoot`/`worktreePath`/
  `scope: GitScope`).
- **`GitScope`** — `branch-vs-base` (`baseRef?`), `commit` (`commitId`),
  `staged`, `uncommitted`, `unstaged`. Each carries only the fields it
  needs.
- **`ChangedFileEntry`** — `additions`/`deletions: number | null` (null =
  binary, never coerced to `0`), `revertible: boolean`, `rootId: string |
  null`, `worktreePath: string | null` (null for every snapshot-sourced
  entry — see Selection semantics under RENDERER SURFACES below).
- **`ChangesetView.totalAdditions`/`totalDeletions: number | null`** — `null`
  means the source cannot report totals at all. Since the W7 snapshot engine
  swap (BST-1164 T2), EVERY changeset kind resolved through
  `ChangesetDiffService` computes REAL totals: `git-scope` from `git diff
  --numstat`, and `agent-run`/`run-range` from the shadow-git snapshot
  diffs' numstat. Binary files' `null` per-file counts are excluded from
  the sum (`?? 0`), not coerced — "every file binary" is a real computed
  `0`. `null` remains in the type for sources that genuinely cannot report
  totals; since T4 deleted the journal fold (`changeset-journal-view.ts`)
  no shipping producer emits `null` totals. `null` (unknown) and `0`
  (computed exactly zero) are deliberately different facts
  (make-invalid-states-unrepresentable).
- **`ChangedFileEntry.toolAttributed?: boolean`** (W7 T2, ADDITIVE) —
  view-level attribution metadata: `true` when the edit-checkpoint
  attribution ledger records an assistant-tool edit touching the path within
  the changeset's range, `false` when the snapshot engine captured a change
  with no tool record (e.g. a shell side effect), ABSENT when no attribution
  join ran (every `git-scope` changeset; the LIVE mid-turn view, which does
  no DB reads). Absent means "no badge", never `false`.
- **`StructuredFileDiffContent`** — three variants, not four (the shipped
  shape; an early PR body described a 4-reason union — see CORRECTIONS
  below): `binary`, `full` (`oldContent`/`newContent: string | null`),
  `hunks-only` (`hunkText`, `hunkTextTruncated`, `reason:
  'diff-overflow' | 'over-cap-both' | 'over-cap-new' | 'over-cap-old'`).
  A `full` payload with empty `hunks` is not a contradiction — `full` only
  promises both sides' complete text, never that hunk ranges were computed
  (binary and `untracked` whole-file adds have empty `hunks` for that
  reason; the journal-sourced no-hunks case died with the journal fold in
  T4 — snapshot diffs are real git diffs and carry hunks).
- **`WorktreeDescriptor`** — `containment: readonly string[] | 'outside-roots'`,
  `provenance: 'agent-reported' | 'both' | 'scanned'`, `trust:
  'unvalidated' | 'validated'`, `trustReason: string | null`. See TRUST RULE
  below — the type's own doc comment states the rule precisely and is worth
  re-reading in place.
- **`StructuredFileDiffParams`** — the per-file diff request: `mode: 'commit'
  | 'range' | 'staged' | 'untracked' | 'unstaged' | 'working'`, each with its
  own doc comment recording why that mode compares what it compares (the
  `unstaged` mode's comment records the BST-1113 review finding — see
  DIFF ENGINE below).
