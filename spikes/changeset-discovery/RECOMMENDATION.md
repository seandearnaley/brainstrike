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
| Single root | `node src/discover.ts .../brainstrike` | 1 | 111 | 35 | 327\* | 277 | 604 | 0 |
| Multi root | `node src/discover.ts .../brainstrike ~/Documents/GitHub` | 166 | 288 | 242 | 894\* | 2641 | 3535 | 2 |

\* `walk ms` is a single cold run and is filesystem-cache-sensitive, not a
stable figure — a review re-run measured 69ms (warm cache) for the
single-root walk against this same 327ms cold figure, a 4.7x spread.
Treat `walk ms` as "order of a few hundred ms cold, tens of ms warm," not
a fixed number. `enumerate ms` (the process-spawn-bound phase) reproduced
within 3% across repeated runs and is the more trustworthy figure of the
two for capacity planning.

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
  returns all **111** worktrees git has registered). Checked the exact
  breakdown directly against the single-root run's `containment` field
  (filtering `inv.repos[0].worktrees` by `containment !== 'outside-roots'`)
  rather than hedging: **34** of the 111 registered worktrees live *inside*
  the scanned root, at depth 3 (`brainstrike/.claude/worktrees/<agent-name>`,
  well within `maxDepth: 6`) — all 34 matched that exact path pattern, no
  exceptions; the root/main worktree itself is a 35th "inside" entry
  (`containment: [root]`, trivially self-contained); the remaining **76**
  are registered with git but live elsewhere on disk entirely, outside the
  scanned root (`containment: 'outside-roots'`). **Zero were missed due to
  walk depth**: the fs walk's `maxDepth: 6` correctly found all 35 gitfile
  entries that are actually inside the root (34 agent worktrees + main);
  the other 76 were learned from `worktree list`'s output regardless of
  depth, precisely because they live outside the scanned root by
  definition, not because the walk failed to reach them. Net: 36 git
  process spawns (35 `rev-parse` + 1 `worktree list`) for 2 useful outcomes
  (1 repo identified, 1 successful `worktree list` covering all 111) plus
  34 *wasted* `rev-parse` calls whose only purpose was to discover "this is
  a dupe."
- Multi root: fs walk finds **242** entries; `buildInventory` dedupes them
  to **166** distinct `RepoEntry`s (166 → 166 `worktree list` spawns, 242
  → 242 `rev-parse` spawns). 76 of the 242 `rev-parse` spawns are pure dupe
  discovery (same math as above, scaled).
- **Q1 data point (per the brief)**: enumerate time (277ms / 2641ms) is
  process-spawn-bound at roughly 6.5–7.7ms per spawn (36 spawns / 277ms ≈
  7.7ms; 408 spawns / 2641ms ≈ 6.5ms), consistent between the two runs. The
  34→76 wasted `rev-parse` calls in these two runs specifically are the ones
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

| Run | Scope | Target | Command | files | list ms | content ms | total ms | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Real repo, clean tree | `uncommitted` | `.../brainstrike` | `node src/scope-diff.ts <path> uncommitted` | 0 | 42.6 | 0.0 | 42.6 | working tree was clean at run time (`git status --short` empty) |
| Real repo, no upstream | `branch-vs-base` | `.../brainstrike` | `node src/scope-diff.ts <path> branch-vs-base` | — | — | — | — | **threw as predicted**: `fatal: no upstream configured for branch 'spike/changeset-discovery'` (exit 128) at the `@{u}` `rev-parse`. See "Spike shortcuts taken" below — this is a Q1/Q3 data point (a visible throw, not a silent empty diff), not a bug. |
| Real linked worktree | `uncommitted` | `.claude/worktrees/agent-a044327b4dcaeeff7` | `node src/scope-diff.ts <path> uncommitted` | 0 | 50.1 | 0.0 | 50.1 | that worktree's tree was clean at run time |
| Real linked worktree, dirty | `uncommitted` | `.claude/worktrees/agent-a834f8049b5212f73` | `node src/scope-diff.ts <path> uncommitted` | 3 | 40.1 | 25.9 | 65.9 | picked after scanning all 25 `agent-*` worktrees for one with a nonzero `git status --porcelain` count, to get a real nonzero-file data point instead of three clean-tree zeros |
| Synthetic 200-file changeset | `uncommitted` | `/private/tmp/spike-big` | `node src/scope-diff.ts <path> uncommitted` | 200 | 36.1 | 1247.1 | 1283.3 | see below |
| Synthetic clone w/ upstream | `branch-vs-base` | `/private/tmp/spike-big-clone` | `node src/scope-diff.ts <path> branch-vs-base` | 2 | 33.2 | 26.6 | 59.8 | workaround for the real repo's missing upstream — see below; `list` here spans 4 spawns, not 2 — see composition note below |

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
changed files, and reported `list=33ms`/`content=27ms`.

**Composition caveat**: that `list=33ms` is not directly comparable to
`uncommitted`'s `list` figure by spawn count. For `uncommitted`, the `list`
phase (`t0`→`t1` in `computeScopeDiff`) is exactly 2 git process spawns:
`diff HEAD --numstat` and `status --porcelain=v2`. For `branch-vs-base`,
`list` additionally spans the `@{u}` `rev-parse` and the `merge-base`
lookup *before* the numstat diff and status calls — 4 spawns total
(`rev-parse @{u}`, `merge-base`, `diff <base>...HEAD --numstat`, `status`).
That `branch-vs-base`'s `list` (33ms, 4 spawns) came out *close to*
`uncommitted`'s `list` (42.6ms real-repo / 40–50ms worktree runs, 2 spawns)
despite doing roughly double the spawn work is itself worth flagging, not
glossing over as "the same range" — it's consistent with the per-spawn
cost measured elsewhere (~6.5–7.7ms/spawn) only if the clone's spawns were
on the faster end of that range; it is not evidence that `branch-vs-base`
and `uncommitted` have equivalent list-phase cost per spawn.

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
| (a) stray delayed event | 1 | 0 | 1 | A single unattributed `delete index.lock <== INVALIDATE` event arrived ~23s after the prior batch, with no git command running at that moment. Cause undetermined — Task 5 flagged git's own background auto-maintenance as at least as plausible as delayed/coalesced FSEvents delivery, without picking one. Not tied to any of the three listed op batches; counted separately here so the totals row reconciles (3 listed batches sum to 30 events / 9 noise / 21 INVALIDATE; this stray event is the 31st event / 22nd INVALIDATE). |
| (a) totals, 3 op batches + 1 stray event | 31 | 9 (29%) | 22 (71%) | **~29% noise ratio is macOS/FSEvents-specific** (loose-object writes, non-index/HEAD/refs lock files) — not a portable constant; a different platform watcher backend (e.g. inotify) would plausibly differ. **Carrying forward Task 5's recommendation**: a production debounce/batch window should tolerate a stray late single-file lock event arriving well outside the normal window, rather than assuming all of an operation's events land inside one window. |
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
   brainstrike `.git` has on the order of ~693 dirs (measured directly:
   `find .git -type d | wc -l` → 695 at the time of this Task 6 run, a
   couple more than Task 5's ~693 snapshot — consistent with ongoing
   activity, not a discrepancy) and ~110 worktree entries at the scale
   measured in Task 6's own discovery run above (111 worktrees), this
   matters for production sizing, not just a synthetic scratch repo.
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
6. **The regex risk is two-directional, not just false-positives — there is
   also a false-negative hole via `packed-refs`.** A bare `packed-refs`
   *content* write (as opposed to its `.lock`) doesn't contain the literal
   `refs/` substring the `INTERESTING` regex requires, so a ref-packing
   operation (`git pack-refs`, `git gc`) that rewrites `packed-refs`
   *without* also touching a matching loose `refs/heads/**` path in the
   same batch would be **missed** entirely — no INVALIDATE at all. In every
   batch Task 5 observed, each `packed-refs` touch happened to co-occur
   with a loose `refs/heads/**` (or its `.lock`) event that *did* match, so
   coverage held in practice for the operations tested — but that's
   incidental to those particular operations, not something the regex
   guarantees for ref-packing in general. Combined with caveat 3 above
   (false positives via bare `index.lock` churn), the regex's risk profile
   runs in both directions: it can both over-fire on read-only commands and
   under-fire on a ref-packing write that doesn't touch a loose ref file.

## Spike shortcuts taken

Transcribed (corrected where noted) from Task 2's, Task 3's, and Task 4's
review findings, for production-port awareness. None of these were fixed in
the spike — they are deliberate, recorded simplifications.

### Task 2 — discovery walk (`discover-repos.ts`)

- **Unguarded `stat` aborts the whole walk on one bad entry**: `walk`'s
  `readdir` call catches failures and warns-and-continues, but the
  `await stat(gitPath)` immediately after finding a `.git` entry is not
  guarded — one transient `ENOENT` (entry removed between `readdir` and
  `stat`) or `EACCES` on that single `.git` path rejects the entire
  `buildInventory` call, not just that entry. Production must catch this the
  same way the `readdir` path already does: catch, emit a visible warning,
  and skip the entry — never let one flaky `.git` stat abort a whole-tree
  scan.
- **Unbounded `Promise.all` directory fan-out**: the recursive walk step fans
  out over every subdirectory of every directory with one `Promise.all` and
  no concurrency cap. Depth is bounded (`maxDepth`), but breadth is not — a
  very wide root (many thousands of sibling directories at one level) can
  spawn that many concurrent `readdir`/`stat` calls at once, risking
  `EMFILE`/`ENFILE` on real-world wide trees, not just pathological ones.
- **Overlapping `rootPaths` double-walk and produce duplicate entries**:
  `discoverRepos` walks each of `rootPaths` independently with no cross-root
  dedup. If two scanned roots overlap (e.g. one is an ancestor of another),
  the overlapping subtree is walked twice, producing two
  `DiscoveredGitEntry` records for the same `.git` path that differ only in
  `containingRoot` — there is no dedup at the walk level (only later, in
  `buildInventory`'s `commonDir`-keyed map, at the cost of an extra wasted
  `rev-parse` spawn per duplicate).
- **Repo-under-repo descent is implemented but untested**: the walker
  deliberately keeps descending into subdirectories after finding a `.git`
  entry — nested repos living below another repo's working tree are real
  (e.g. `.claude/worktrees/*` under the main checkout) — but no test
  exercises a `.git` directory nested inside a *sibling* subdirectory of an
  already-found repo (as opposed to nested inside the found repo's own
  `.git` directory, which the existing "does not descend into .git" test
  covers). Correct by inspection, not pinned by a test.

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
- **Bare main worktree yields `head: ''`, not an absence**:
  `parseWorktreePorcelain` reads `fields.get('HEAD') ?? ''` — git's
  porcelain output omits the `HEAD` field entirely for a bare main
  worktree, so the parser's fallback silently substitutes an empty string.
  `WorktreeEntry.head: string` has no way to express "this worktree has no
  HEAD" as distinct from "the HEAD line was empty"; a production port
  should type `head` as `string | null` and preserve the field's actual
  absence rather than coercing it to `''`.
- **Containment prefix test assumes POSIX separators, untested on
  Windows**: `classifyContainment`'s prefix check
  (`worktreePath.startsWith(root + sep)`) uses `path.sep`, which is `\` on
  Windows, while git's own porcelain `worktree` paths use `/` regardless of
  platform — every containment prefix comparison would fail to match on
  Windows as a result. This spike was only ever run and verified on macOS;
  the Windows case is unverified, not merely untested.

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
- **`timingMs.list` is inflated for `staged` and `branch-vs-base`, but NOT
  for `uncommitted`**: `computeScopeDiff` always runs `git status
  --porcelain=v2 -z --untracked-files=all` to collect untracked paths, but
  that result is only *consumed* when `scope === 'uncommitted'` (to append
  `'U'` entries). For `uncommitted`, the status call is load-bearing — it's
  the only source of untracked-file paths, so its cost belongs in
  `timingMs.list` for that scope. For `staged` and `branch-vs-base`,
  however, the status call still runs (same code path, unconditional) but
  its output is discarded — untracked files are structurally irrelevant to
  a staged-only or branch-vs-base diff, so that call's cost is pure waste
  folded into `timingMs.list` for exactly those two scopes. This means
  `timingMs.list` is **not** an apples-to-apples "list cost for this scope"
  figure across scopes as currently measured/reported above — only the
  `staged` and `branch-vs-base` `list` numbers carry a not-always-needed
  extra `git status` call; `uncommitted`'s `list` number does not (its
  status call is necessary work, not inflation). `branch-vs-base` further
  compounds this with the two additional `@{u}`/`merge-base` spawns noted
  in the scope-diff table above — its `list` figure is the most
  spawn-heavy and least comparable of the three scopes.
- **`parseNumstat`'s `.filter(Boolean)` drops empty fields before
  positional indexing of rename triples**: the parser splits `numstat -z`
  output on `\0` and immediately `.filter(Boolean)`s the result, then reads
  a rename's old/new path pair positionally (`i += 2` to skip the old path
  and land on the new path). If an unexpected empty field ever appears in
  the stream (not the normal rename-record shape), `.filter(Boolean)`
  silently removes it — shifting every subsequent positional index by one
  and misreading unrelated fields as if they belonged to a different
  record, instead of failing loudly. A production parser must not filter
  empty fields out before doing positional decode of the rename shape; it
  must either validate field count per record or use a non-positional
  parse.

## Answers to spec §10

Five rulings for the W2/W3/W5 implementers. Each cites the evidence it stands
on and names the runner-up. Where a ruling reaches the edge of this spike's
evidence, the unverified part is named explicitly instead of resolved by guess.

### Q1 — Walk cost, ignore strategy, indexer-traversal reuse

**Ruling: the inventory walk stays independent — a bounded main-process fs walk
(maxDepth 6, its own small ignore set), NOT a reuse of the Workspace Index
traversal. The optimization budget goes to the enumerate phase (gitfile-pointer
dedup before spawning), not the walk.**

Measured basis (Discovery table above):

- The walk is the cheap phase: 69ms warm / 327ms cold single-root, 894ms cold
  across a 166-repo multi-root sweep. The enumerate phase dominates (277ms /
  2641ms) and is process-spawn-bound at ~6.5–7.7ms/spawn. Sharing traversal
  machinery would optimize the phase that is already fast.
- 76 of the multi-root run's 242 `rev-parse` spawns (34 of 35 single-root
  `rev-parse` spawns; 36 total including the `worktree list` spawn) were
  pure dupe discovery. Parsing the `gitdir:` line out of each `.git` file and
  deduping on it *before* spawning is the recorded fix — that is where the
  measured waste is.
- `maxDepth: 6` missed zero in-root worktrees (all 34 agent worktrees sit at
  depth 3, `brainstrike/.claude/worktrees/<name>`); out-of-root worktrees come
  from `worktree list` regardless of walk depth. Keep 6.

Why not reuse `createBackgroundIndexingEntryPolicy`
(`packages/utils/src/background-indexing-policy.ts`, per
`docs/agents/explorer-search-tapestry.md` §Workspace Index Traversal):

1. **Opposite ignore semantics — divergence here is a correctness bug, not
   drift.** The indexer's policy exists to *prune* dependency/generated dirs
   from content indexing; the inventory walk exists to *find* `.git` entries —
   including under directories the explorer stack ignores. Concretely:
   `DEFAULT_IGNORE_PATTERNS` (`packages/utils/src/path-filter.ts`) contains
   `.git` itself, and 34 of the 35 in-root discoveries live under
   `.claude/worktrees/*` — exactly the kind of dot-directory an indexing
   policy is free to exclude tomorrow (un-indexing `.claude/worktrees` is an
   open indexer question already). A shared list means a future indexer
   exclusion silently blinds repo discovery — a silent fallback by proxy.
2. **Coupling direction.** The indexer traversal is renderer-driven (policy
   consumed by the renderer-side walker, cancellation owned by provider sync
   runs); `GitInventoryService` is a main-process service. Sharing means
   importing renderer-lifecycle-shaped machinery into main for no measured win.
3. **The walk needs different mechanics anyway:** stop descending into `.git`,
   classify dir-vs-gitfile, keep walking *below* a repo boundary (nested repos
   under `.claude/worktrees` are real — see `discover-repos.ts`'s boundary
   comment).

The inventory keeps its own small name-set ignore (the spike's `DEFAULT_IGNORE`:
`node_modules`, build outputs, caches, `.venv`, etc.). It may *reference* the
shared list for name choices, but the contract is separate on purpose, and the
divergence is documented rather than accidental.

**Runner-up:** share the indexer traversal + policy. Rejected on all three
grounds above; the measured walk cost (tens of ms warm) cannot justify the
coupling, and the ignore-list "reuse" would actively fight the inventory's job.

### Q2 — `.git` metadata watching vs the one-pipeline ruling

**Ruling: a separate main-process `@parcel/watcher` subscription per repo
common `.git` dir, owned by the `changes` domain and emitting on the `changes`
domain's own single event channel — NOT a new signal type on the explorer's
`fs:watch-event` channel. This does not violate the explorer's one-pipeline
ruling; confirmed against the doc's actual wording.**

Evidence for per-common-dir sufficiency (Task 5, scenario (b), CONFIRMED): one
watch rooted at the main repo's `.git` observes every linked worktree's
ref/index/HEAD activity (`worktrees/<name>/{index,HEAD.lock,logs/HEAD}` plus
shared `refs/`), because all linked-worktree git metadata lives in the common
dir. So the subscription count is **one per repo** (166 in the worst measured
corpus), not one per worktree (288) — and explicitly NOT for working-tree
content, which stays with the existing explorer refresh pipeline exactly as
spec §6 already divides it.

Why this is not a second explorer channel — the ruling's wording, checked:
`docs/agents/explorer-search-tapestry.md` §Explorer tree live refresh opens
"One pipeline keeps **the visible tree, forest roots, and the background
indexer** in sync with on-disk changes. Do not add a second event channel or a
polling fallback." The ruling's scope is the explorer refresh pipeline and its
three named consumers. A `changes`-domain invalidation stream feeds a different
consumer (inventory snapshots / changeset stores) under its own contract
(spec §6: one event channel, monotonic generation guard, no polling) and never
touches `FILE_EXPLORER_REFRESH_EVENT` or `fs:watch-event`. The discipline the
ruling encodes — one channel per pipeline, no polling — is preserved *inside*
the changes domain, not evaded. **Confirmed, not refuted.**

Why the runner-up (new signal type on the existing `fs:watch` channel) loses on
structure, not taste:

1. The explorer watch stack is natively blind to `.git`:
   `DEFAULT_IGNORE_PATTERNS` includes `.git` and feeds @parcel/watcher's
   native-level ignore globs. Surfacing git metadata there means un-ignoring
   `.git` for every explorer watcher — flooding a pipeline whose consumers
   (tree refresh, indexer) must then re-filter events they never wanted.
2. Lifecycle mismatch: explorer watchers are renderer-owned
   (per-`WebContents`, rooted at workspace roots, reaped with the renderer);
   repo watchers follow inventory lifecycle (repos appear/disappear with
   discovery, main-process-owned) and must cover common dirs of out-of-root
   worktrees' repos — paths that may lie outside every watched workspace root.
3. Consumer contract mismatch: the explorer channel carries structural tree
   deltas; this stream carries "invalidate repo X" triggers.

Production requirements carried forward from Task 5 (binding on W2, not
optional polish — full detail in the watcher caveats list above):
`fs.realpath` the watch root before slicing event paths; add an explicit
`(^|\/)worktrees\/[^/]+$` clause (worktree add/remove coverage is currently
incidental); close the `packed-refs` content-write false-negative hole with an
explicit `packed-refs` (non-`.lock`) clause; treat the 300ms window as a fixed
batch window whose invalidations a slow operation can span, and tolerate stray
late lock events; consider requiring an actual `index` write rather than
`index.lock` cycling so read-only `git status` stops false-firing.

### Q3 — `StructuredFileDiff` size caps and lazy-hunk strategy

**Ruling: eager `ChangesetView` + lazy per-file `StructuredFileDiff` is
CONFIRMED by measurement. Per-file, per-side full-content cap: 2 MB (matching
the journal capture cap). Over-cap files degrade to hunk-only rendering with an
explicit truncation marker — never full-file context, never a silent trim.**

The numbers (Scope diff section above):

- The eager list phase is flat and cheap: ~30–50ms per changeset regardless of
  file count (single `numstat` + `status` invocation pair).
- Eager content does not scale: 200 files cost 1247ms at ~6.2ms/file fully
  serialized — spawn-bound, matching the independently measured
  ~6.5–7.7ms/spawn — extrapolating to ~12s for a 2,000-file changeset. Lazy
  per-file resolution makes the interactive cost one file (~6ms + read) at a
  time; batching (`git cat-file --batch` or bounded concurrency) is justified
  the moment any surface legitimately needs content for more than a few dozen
  files at once (e.g. expand-all), and not before.

Cap value, anchored to the two production precedents rather than invented:

- `GIT_MAX_OUTPUT_BYTES = 1_000_000` (`apps/desktop/src/assistant-server/git-service.ts:72`)
  is a *soft output* ceiling: `boundOutput` truncates with a visible
  `…(output truncated)` marker (hard `execFile` buffer 4×).
- The edit-checkpoint journal caps captured before-content at **2 MB**, and
  above it records `skipped_too_large` with NULL content — honestly absent,
  never a truncated snapshot (`docs/agents/workspace-context.md` §Edit
  Checkpoint Journal).

**Per-side full-content cap = 2 MB** because `agent-run`/`run-range` changesets
join *journal* before-content, which structurally cannot exceed 2 MB — a larger
diff-viewer cap would advertise capacity the journal side can never fill, and a
smaller one would truncate content the journal explicitly preserved. Git-scope
sides use the same cap for one uniform contract. The rendered *hunk* payload of
an over-cap file is bounded by the existing `GIT_MAX_OUTPUT_BYTES` pattern
(1 MB soft, marker on trim).

Over-cap UX (answering spec §7's marker requirement precisely): a file whose
either side exceeds 2 MB, or whose ref-side read reports binary, resolves with
`truncated: true` (or the binary flag), **hunk-only rendering** (structured
hunk ranges + bounded hunk text from `git diff` — real line numbers preserved),
and NO full-file context lines; the UI renders the §7 visible truncation marker
stating which side was over cap. Binary files render a binary placeholder, no
hunks. Both are explicit states in `StructuredFileDiff`, mirroring the
journal's `skipped_binary`/`skipped_too_large` honesty — the NO SILENT
FALLBACKS shape of this ruling.

Production port notes from the shortcuts list (binding on W1/W3): ref-side
reads must use `runGitBuffer` (raw buffer — `runGit`'s utf8 decode mangles
binary before the null-byte check runs), and `readSide`'s bare catch must be
split so "absent at ref" (expected) is distinguished from real errors
(ENOBUFS/EACCES/EISDIR) instead of both becoming a fake 'A' status.

**Runner-up:** eager full-content resolution with a bigger cap (or eager
hunk extraction for all files). Rejected on the 6.2ms/file serialized
measurement — it front-loads seconds of spawn time onto changeset open for
content the user may never scroll to, and 200 files is not pathological
(a rebase or generated-file dump reaches 10× that).

### Q4 — Mastra message-tombstone seam (soft rewind)

**Ruling: the tombstone marker lives in a new Brainstrike sidecar table —
`brainstrike_assistant_message_tombstones` — never in `mastra_threads.metadata`
and never as a column on `mastra_messages`. Filtering happens at BOTH
Brainstrike-owned read boundaries: the app-shell hydration query and
`PgliteMemoryStore.listMessagesWhere`. Finalization hard-deletes through
Mastra's own `deleteMessages` storage API. Two named items require
mastra-boundary review as W5 preconditions.**

The seam, concretely:

- **Table** (migration-055 `brainstrike_assistant_message_parents` precedent —
  the existing per-message sidecar): registered in BOTH migration runners +
  byte-identical bootstrap in `ASSISTANT_THREAD_RUNS_SCHEMA_SQL`-style
  app-shell mirror; NO FKs (numbered runner executes on a bare schema);
  explicit factory-reset registration and membership in the ordered
  `THREAD_DELETE_SIDECAR_TABLES` cascade spec. Columns:
  `message_id` (PK), `thread_id`, `tombstoned_at`, and `revert_id` (uuidv7
  batch id shared by all rows one soft-rewind created).
- **(a) Hydration filters without forking Mastra internals.** Two read paths
  exist and both are Brainstrike code:
  1. UI hydration — `packages/app-shell/src/assistant-memory-repository.ts`'s
     80-row window adds a LEFT-JOIN anti-join on the tombstone table (same
     shape as its existing parents-edge join). Tombstoning always removes a
     contiguous *suffix* of the thread (everything after the checkpoint), so
     the parent graph stays closed — only leaves and their descendants vanish.
  2. Model-facing recall — `PgliteMemoryStore` **extends Mastra's public
     `MemoryStorage`** (`packages/agent/src/pglite-mastra-memory/memory-store.ts:89`);
     all list reads funnel through one private `listMessagesWhere` (`:1008`),
     which gains the same exclusion. This is the sanctioned storage seam, not
     a fork — precedent: the store already applies the transcript projection
     policy at its `saveMessages` durable boundary.
  A shared SQL predicate/fragment must be exported once (the
  `THREAD_DELETE_SIDECAR_TABLES` / `RUN_LEDGER_AGGREGATION_SQL` single-source
  convention) so the two filters cannot drift.
- **(b) One-level redo un-tombstones exactly.** Redo = `DELETE FROM
  …message_tombstones WHERE revert_id = <latest batch>`. Content rows were
  never touched, so redo is an exact inverse with no reconstruction — this is
  why per-message rows beat any boundary marker.
- **(c) Next user message finalizes.** The send path already writes the new
  user message's parent edge through the app-shell repository's `append`
  callback; finalization runs in that same repository seam: resolve the
  thread's outstanding tombstoned ids, hard-delete via
  `PgliteMemoryStore.deleteMessages(messageIds)` (an existing `override`,
  `memory-store.ts:507` — Mastra's own storage API, so Mastra remains the
  writer of message content), then clear the sidecars (tombstone rows, parents
  edges; the thread-search index rows are cleared eagerly like thread deletion
  does, with sync GC as the self-heal).

**W5 preconditions — mastra-boundary review, explicitly NOT resolved here**
(the evidence reaches its edge; per `docs/agents/mastra-boundary.md` these
need a ruling, not an assumption):

1. **Sanction filtered `listMessages` output as legitimate storage-seam
   behavior.** Filtering changes what Mastra believes the thread contains.
   Unverified in this spike: whether observational-memory observation runs and
   `semanticRecall` vector reads flow through `listMessagesWhere` — and OM
   observations *already generated* from later-tombstoned messages cannot be
   un-observed. W5 must verify those read paths and rule on the OM residue
   before shipping, or soft rewind silently lies to memory.
2. **BST-993 mind-ops vocabulary.** Finalization is a real deletion of mind
   state, but `brainstrike_mind_ops.entity_kind` is CHECK-constrained to
   `{thread, prompt_item}` and the seam doc says widening is "a conscious
   migration, never a drift channel". W5 needs the ruling on whether
   message-level deletes emit ops (they are "the mind"; a future sync engine
   cannot reconstruct them after the fact).

**Runner-up:** a tombstone-boundary flag in `mastra_threads.metadata`
(the `operatingRootId` precedent). Rejected: (1) hydration merges progressive
snapshot rows and breaks ties on equal timestamps — interpreting a time/id
boundary at every read against that machinery is exactly the ambiguity
explicit per-message ids eliminate; (2) redo and finalization need batch
identity (which rows THIS rewind tombstoned), which a single flag cannot
carry; (3) metadata writes ride `saveThread`, whose transactional semantics
are already tuned for title policy — a second bookkeeping writer on a
Mastra-owned row is the wrong direction when every prior per-message need
(parents 055, search index 067) settled on sidecars.

### Q5 — Cross-thread conflict awareness in v1

**Ruling: the existing per-file hash-compare conflict surfacing is sufficient
for v1. No proactive cross-thread detection. Recorded as settled for W5.**

The two-thread case, reasoned against the journal's actual semantics
(`docs/agents/workspace-context.md` §Edit Checkpoint Journal): thread B edits
file F after thread A's run; A's range-revert compares the stored `after_hash`
against current disk under the per-file lock → mismatch → per-file conflict
(`ok:false conflict`), surfaced in the acknowledgment-requiring conflict list
with "Revert anyway" (force) as the explicit override, and `revertRun` stays
honest about partial success. Nothing is silently lost or silently skipped —
which is the house bar (spec §7), and it is *writer-agnostic*: thread B, the
user's own editor, and an external tool are indistinguishable at the disk and
are all caught by the same compare. Single-device local-first (no sync layer)
means there is no writer the hash compare cannot see at apply time.

Adopt the teardown's W5 acceptance criterion as the testable phrasing: a
revert whose per-file hash check fails must surface every conflicting file by
path and require explicit acknowledgment before any part of the revert is
applied — `ConversationRevertService` hash-checks all files first, then
applies, so the conflict list is pre-apply rather than mid-apply.

**Runner-up:** proactive cross-thread detection (query other threads' journal
entries touching the same paths and warn before reverting). Rejected for v1
because it is a strictly weaker second mechanism layered on the authoritative
one: it sees only journaled writers (blind to the user and external tools —
false negatives), it flags edits that no longer conflict (B's change itself
reverted, or content restored to the expected hash — false positives), and it
cannot replace the apply-time hash check, so it adds UI and a second code path
without changing any outcome the hash compare doesn't already force into the
open. A cheap post-v1 enhancement that preserves this ruling: annotate a
*detected* conflict with the last journaled writer of that path ("modified by
thread <title>") — enrichment of the honest surface, not a new detector.
