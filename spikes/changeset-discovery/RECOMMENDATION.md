# Changeset discovery spike — recommendation (BST-1110)

Findings from Tasks 1–5's prototypes (`src/discover.ts`, `src/scope-diff.ts`,
`src/watch-git.ts`), measured against the real corpus in Task 6. All runs
below are read-only against the user's checkout (`git diff`/`status`/
`rev-parse`/`merge-base`/`cat-file` + fs reads only — verified against
`src/git.ts`, `src/inventory.ts`, `src/scope-diff.ts` before running: no
mutating git subcommand is invoked anywhere in these three files). Synthetic
repos (`/tmp/spike-big`, `/tmp/spike-big-clone`) were created and destroyed
under `/tmp`/`/private/tmp` only; the real brainstrike checkout was never
written to.

## Measurements

### Discovery (`discover.ts`)

Machine: macOS, Node v24.16.0, run from `spikes/changeset-discovery`.

| Run | Command | repos | worktrees | pre-dedup fs-walk entries | walk ms | enumerate ms | total ms | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Single root | `node src/discover.ts .../brainstrike` | 1 | 111 | 35 | 327 | 277 | 604 | 0 |
| Multi root | `node src/discover.ts .../brainstrike ~/Documents/GitHub` | 166 | 288 | 242 | 894 | 2641 | 3535 | 2 |

Multi-root scanned `~/Documents/GitHub` (171 top-level entries, many
multi-year-old clones/forks — a real "worktree-and-fork-heavy home
directory" corpus, not a contrived worst case) plus the brainstrike repo
itself. It completed in ~3.5s wall clock, well under the brief's ~3-minute
concern threshold — the "scan `~/Documents/GitHub`, kill it if it exceeds
3 minutes and fall back to a smaller pair of repos" contingency was not
needed; the full run's real numbers are recorded above instead of a
fallback.

**Pre-dedup entry counts** (measured directly by calling `discoverRepos`
before the `buildInventory` dedup/rev-parse step, to make the brief's "note
process count" idea concrete rather than hand-waved):

- Single root: fs walk finds **35** `.git` file/dir entries under
  `brainstrike` (main + worktree gitlinks within `maxDepth: 6`), all of
  which resolve via `rev-parse --git-common-dir` to the **same** repo — so
  `buildInventory` spawns 35 `rev-parse` calls but only 1 of them survives
  the dedup check to also spawn `worktree list --porcelain` (which then
  returns all **111** worktrees git has registered — most of those 111 live
  deeper than `maxDepth: 6` or outside the scanned root entirely, i.e. they
  were never found by the fs walk at all; they come from git's own
  worktree-list output, not from the walk). Net: 36 git process spawns for
  36 useful outcomes (1 repo, 1 successful worktree-list) plus 34 *wasted*
  `rev-parse` calls whose only purpose was to discover "this is a dupe."
- Multi root: fs walk finds **242** entries; `buildInventory` dedupes them
  to **166** distinct `RepoEntry`s (166 → 166 `worktree list` spawns, 242
  → 242 `rev-parse` spawns). 76 of the 242 `rev-parse` spawns are pure dupe
  discovery (same math as above, scaled).
- **Q1 data point (per the brief)**: enumerate time (277ms / 2641ms) is
  process-spawn-bound at roughly 6.5–7.7ms per spawn (36 spawns / 277ms ≈
  7.7ms; 408 spawns / 2641ms ≈ 6.5ms), consistent between the two runs. The
  36→76 wasted `rev-parse` calls in these two runs specifically are the ones
  spent purely discovering that a gitfile points at an already-seen
  `gitdir`. Parsing the `gitdir: <path>` line out of each `.git` file
  directly (no process spawn) and deduping on that string *before* spawning
  any `rev-parse` would eliminate those wasted spawns — recording this idea
  per the brief's instruction, not building it in this spike.
- 2 errors on the multi-root run, both real and expected, not spike bugs:
  `brainstrike-feature-branch` (a stale `.git` directory whose `.git` file
  no longer resolves — `fatal: not a git repository: (null)`) and a `uv`
  Python package cache under `log-compact/.uv/sdists-v9` containing an
  unrelated `.git`-named file with an invalid gitfile format. Both are
  correctly captured in `Inventory.errors` rather than crashing the run or
  being silently dropped.

### Scope diff (`scope-diff.ts`)

| Run | Scope | Target | files | list ms | content ms | total ms | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Real repo, clean tree | `uncommitted` | `.../brainstrike` | 0 | 42.6 | 0.0 | 42.6 | working tree was clean at run time (`git status --short` empty) |
| Real repo, no upstream | `branch-vs-base` | `.../brainstrike` | — | — | — | — | **threw as predicted**: `fatal: no upstream configured for branch 'spike/changeset-discovery'` (exit 128) at the `@{u}` `rev-parse`. See "Spike shortcuts taken" below — this is a Q1/Q3 data point (a visible throw, not a silent empty diff), not a bug. |
| Real linked worktree | `uncommitted` | `.claude/worktrees/agent-a044327b4dcaeeff7` | 0 | 50.1 | 0.0 | 50.1 | that worktree's tree was clean at run time |
| Real linked worktree, dirty | `uncommitted` | `.claude/worktrees/agent-a834f8049b5212f73` | 3 | 40.1 | 25.9 | 65.9 | picked after scanning all 25 `agent-*` worktrees for one with a nonzero `git status --porcelain` count, to get a real nonzero-file data point instead of three clean-tree zeros |
| Synthetic 200-file changeset | `uncommitted` | `/private/tmp/spike-big` | 200 | 36.1 | 1247.1 | 1283.3 | see below |
| Synthetic clone w/ upstream | `branch-vs-base` | `/private/tmp/spike-big-clone` | 2 | 33.2 | 26.6 | 59.8 | workaround for the real repo's missing upstream — see below |

**Synthetic 200-file changeset setup** (`/tmp/spike-big`, destroyed after
measurement): `git init`, 200 files × 500 lines, commit, then all 200 files
rewritten to 600 lines (uncommitted). `scope-diff.ts uncommitted` against it
(passing the `/private/tmp/...` realpath per the macOS-symlink note, not the
`/tmp/...` alias) reports 200 `M` entries, `list=36ms`,
**`content=1247ms`**. That content cost is ~6.2ms/file for 400 sequential
reads (200 `cat-file blob` process spawns for the old side + 200
`fs.readFile` calls for the new side, fully serialized per Task 4's
"sequential per-file reads" shortcut) — consistent with the ~6.5–7.7ms/spawn
figure measured independently in the discovery runs above, so the number is
not an anomaly, it's dominated by `cat-file` process-spawn overhead, not I/O.
**Extrapolation**: at ~6ms/file, a 2,000-file changeset (10× this size, not
unrealistic for a big rebase/generated-file dump) would cost roughly
**12 seconds** of serialized content-read time alone, with `list` cost
staying flat (single git invocation, ~30–40ms regardless of file count).
This confirms the spec §4 plan's premise: eager numstat listing is cheap and
scope-independent, but eager *content* reading does not scale — batching
(`git cat-file --batch`, already-available-but-unused `runGitBuffer` reuse,
or the spec's lazy-per-file-content approach) is justified once changesets
exceed roughly a few dozen files, not merely a nice-to-have for pathological
cases.

**`branch-vs-base` workaround**: the current branch
(`spike/changeset-discovery`) tracks no upstream in the real repo, so
`scope-diff.ts branch-vs-base` throws there by design (confirmed above, not
worked around in the real repo — no upstream was configured on the user's
checkout to make it succeed). To get a real `branch-vs-base` measurement,
`/tmp/spike-big` was cloned to `/tmp/spike-big-clone` (`git clone` sets
`origin` as a real upstream), then one empty commit plus a two-file edit
commit were added on top of the clone's `main`. `branch-vs-base` against the
clone correctly resolved `base` via `merge-base HEAD origin/main`, found 2
changed files, and reported `list=33ms`/`content=27ms` — both in the same
range as the other small-changeset runs above.

### Watcher observations (from Task 5, `watch-git.ts`)

Task 6 did not re-run the watcher harness (out of scope for this task's
brief — Task 5 already produced the observation data below against
synthetic/scratch repos, never the real checkout). Summarized here for the
measurements section per the brief:

| Scenario | Events | Noise | INVALIDATE | Key finding |
| --- | --- | --- | --- | --- |
| (a) `git status` (read-only) | 2 | 0 | 2 | **False positive**: a no-op read-only command still cycles `index.lock`, which alone matches the `INTERESTING` regex — triggers INVALIDATE for zero actual change. |
| (a) `touch (outside repo) && git add -N . ; git reset` | 10 | 2 (20%) | 8 | No-op reset still writes reflog (`ORIG_HEAD`, `logs/HEAD`) and cycles the branch ref lock — correctly caught, but confirms lock/reflog churn happens even without content change. |
| (a) `commit --allow-empty && reset --hard HEAD~1` (one 300ms window) | 18 | 7 (39%) | 11 | Both commands landed in a single debounce window only because they ran back-to-back well under 300ms — not guaranteed for slower ops. |
| (a) totals, 4 op batches | 31 | 9 (29%) | 22 (71%) | **~29% noise ratio is macOS/FSEvents-specific** (loose-object writes, non-index/HEAD/refs lock files) — not a portable constant; a different platform watcher backend (e.g. inotify) would plausibly differ. |
| (b) commit inside linked worktree, watch rooted at **main** `.git` | 9 interesting (debounced) | — | — | **Confirmed**: one watch on the main/common `.git` dir sees all linked-worktree ref/index/HEAD activity (`worktrees/<name>/{index,HEAD.lock,logs/HEAD}`, shared `refs/`) — no per-worktree subscription needed for git-metadata reactivity. Does **not** extend to working-tree content (uncommitted edits) — that lives outside `.git` per worktree and needs its own watch. |
| (c) `git worktree add` | 21 | 11 (52%) | 10 | Coverage of the new worktree's `HEAD`/`index`/`logs/HEAD` creation is **incidental**, not by an explicit worktree-lifecycle rule — the bare `worktrees/<name>` directory create/delete itself doesn't match the regex. |
| (c) `git worktree remove` | 10 | 5 (50%) | 5 | Same incidental-coverage caveat as add. |

Key caveats to carry forward (do not relitigate, see Task 5 report for full
detail):

1. **One watch per repo is sufficient for git *metadata*** (refs/HEAD/index
   across all linked worktrees, via the shared common `.git` dir) — but
   never for working-tree content, which needs a watch per checkout root.
2. **The 300ms window is a fixed batch window armed by the first event, not
   a trailing/sliding debounce.** It does not guarantee a whole git
   operation collapses into one invalidation; a slower op whose writes span
   the window boundary produces multiple invalidations. Given the real
   brainstrike `.git` has on the order of ~693 dirs and ~110 worktree
   entries at the scale measured in Task 6's own discovery run above (111
   worktrees), this matters for production sizing, not just a synthetic
   scratch repo.
3. **`index.lock` churn alone can trigger a false-positive INVALIDATE** on
   fully read-only commands like `git status`.
4. **Worktree add/remove invalidation is currently accidental** (via
   co-occurring `HEAD`/`index` writes in the same batch), not an explicit
   rule — a production watcher wanting a guaranteed non-incidental trigger
   for "a worktree was added/removed" should add an explicit
   `(^|\/)worktrees\/[^/]+$` clause.
5. **Production must `realpath` the watch root before slicing event
   paths** — `@parcel/watcher` returns realpath'd paths; a symlinked root
   (macOS `/tmp`, `/var`) will silently misparse the path-prefix slice
   otherwise.

## Spike shortcuts taken

Transcribed verbatim (corrected) from Task 3's and Task 4's reports, for
production-port awareness. None of these were fixed in the spike — they are
deliberate, recorded simplifications.

### Task 3 — porcelain-parser comparison (`inventory.ts`)

`parseWorktreePorcelain`'s `.split('\0\0')` record-boundary assumption held
up correctly against real `git worktree list --porcelain -z` output (all
worktrees, including detached ones, parsed correctly — no discrepancy
found). Compared against the production parser
(`apps/desktop/src/assistant-server/git-repository-parsers.ts:86`,
`parseWorktreeSummaries`):

- The spike splits the whole stream on double-NUL (`\0\0`) to find record
  boundaries. This is *equivalent* to the production approach for
  well-formed git output (each field is individually NUL-terminated, so two
  consecutive NULs appear exactly at record boundaries and nowhere else),
  but the production parser is more defensive: it splits on single `\0` and
  treats an *empty* field as the record terminator, which doesn't assume a
  clean double-NUL is always present (e.g. at end-of-stream).
- The production parser validates each field line via a field-name dispatch
  (`applyWorktreeField`) that **throws on any unrecognized field**; the
  spike's parser silently ignores unrecognized fields by simply not adding
  them to its `fields` Map. Acceptable for a spike; a production port should
  adopt the throw-on-unknown-field strictness (this repo's NO SILENT
  FALLBACKS rule).
- Separately (not a parser issue): `classifyContainment` trusts
  caller-supplied root paths to already be canonical. A caller passing raw,
  non-canonicalized paths (e.g. macOS `/tmp`, `/var` symlinks) gets silent
  containment misclassification unless both sides are `realpath`-resolved
  first. The spike's `inventory.ts` does canonicalize via
  `canonicalizeRoots` (added in a review-fix round) — this is done in the
  spike, but any *other* future consumer combining caller-supplied paths
  with git-reported paths needs the same canonicalization, not just this
  one call site.

### Task 4 — known spike shortcuts (`scope-diff.ts`)

Implemented exactly as the brief specified and deliberately not fixed:

- **Rename collapsing**: `parseNumstat`'s renamed-file handling
  (`inlinePath === ''` → skip old path, key by new path only) means a
  `git mv` + edit is reported as a single entry under the *new* path — the
  old path gets no entry at all, so the rename's source side is invisible
  by omission. Worse, this isn't even visible as a distinct status: because
  `readSide(worktreePath, oldRef, newPath)` looks up the *new* path at the
  *pre-rename* ref (where it doesn't exist), the lookup fails and falls
  into `readSide`'s catch branch, producing `old.content === null` — which
  the status-derivation logic then reads as "added." So a rename is
  reported as `status: 'A'` with `oldContent: null`, not `status: 'M'` or
  `'R'` — `'R'` is never assigned anywhere in this prototype despite being
  part of the `FileDiffEntry['status']` type union. The rename's source
  path is silently absent from the diff entirely, not merely mislabeled.
- **`readSide`'s bare `catch` collapses all failure modes into "absent
  side"**: an ENOBUFS on a tracked blob exceeding `runGit`'s 64MB
  `maxBuffer`, an EACCES, an EISDIR, or any other unexpected git/fs error is
  indistinguishable from "path doesn't exist at this ref" — all silently
  become `{ content: null, binary: false, overCap: false }`, which then
  drives A/D status derivation and can misreport status for reasons that
  have nothing to do with add/delete. A production port must distinguish
  "path not present at this ref" (expected) from other errors via git's
  exit code/stderr, and note the asymmetry against the worktree-side read
  (`fs.readFile`, no analogous size ceiling to `cat-file`'s buffer cap).
- **Untracked-file `additions` count is off by one**: for `status: 'U'`
  entries, `additions` is computed as `now.content?.split('\n').length`. A
  trailing-newline-terminated file (`'new\n'`) splits into `['new', '']` —
  length 2 — double-counting the trailing empty segment where real `git`
  would report 1 line added.
- **`runGitBuffer` is dead code, and is the one-line fix for the
  binary-mangling shortcut**: `readSide` reads git-tracked ref content via
  `runGit`, which decodes stdout as utf8
  (`Buffer.from(await runGit(...), 'utf8')`) — so any binary content on the
  old/ref side is already utf8-mangled *before* the `buffer.includes(0)`
  binary check ever runs, making that check unreliable for the ref side
  specifically (the worktree/new side, read via plain `fs.readFile`, is
  unaffected). `git.ts` already exports `runGitBuffer` (raw
  `encoding: 'buffer'`, no decode/re-encode round-trip) but nothing in
  `scope-diff.ts` calls it — swapping the `cat-file blob` read in
  `readSide` from `runGit` to `runGitBuffer` would fix this in one line.
- **Sequential per-file content reads**: `computeScopeDiff` awaits
  `readSide` once per file in a plain `for...of` loop (old side, then
  new/index side), fully serialized — no `Promise.all` batching and no
  `cat-file --batch` process reuse. `timingMs.content` captures exactly this
  cost; Task 6's 200-file synthetic measurement above (1247ms, ~6.2ms/file)
  is the concrete signal this shortcut was meant to produce.
- **`timingMs.list` is inflated for `staged` and `branch-vs-base`**:
  `computeScopeDiff` always runs `git status --porcelain=v2 -z
  --untracked-files=all` to collect untracked paths, but that result is
  only consumed when `scope === 'uncommitted'` (to append `'U'` entries) —
  for `staged` and `branch-vs-base` the status call's cost is paid and
  folded into `timingMs.list` even though its output is discarded. This
  means `timingMs.list` is **not** an apples-to-apples "list cost for this
  scope" figure across scopes as currently measured/reported above — the
  `uncommitted` and `branch-vs-base` `list` numbers in the table both
  include one extra, not-always-needed `git status` call.

## Answers to spec §10

(Task 8)
