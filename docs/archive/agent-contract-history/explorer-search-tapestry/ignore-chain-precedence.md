# Workspace walk ignore-chain precedence — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "WORKSPACE WALK: IGNORE FILES ARE THE PRIMARY SIGNAL, THE POLICY IS THE FLOOR".
Read before adding an ignore source, reordering the precedence table, or changing how scopes are compiled.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '615,761p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

## WORKSPACE WALK: IGNORE FILES ARE THE PRIMARY SIGNAL, THE POLICY IS THE FLOOR

`walkWorkspaceRoot` (`apps/desktop/src/assistant-server/workspace-file-walk.ts`)
honours the ignore-file chain when the caller passes `respectGitignore`
(BST-1427, extended by BST-1431/BST-1432), with
`createBackgroundIndexingEntryPolicy('balanced')` beneath it as a floor.

**ONE precedence order, lowest first — do not add a source without placing it
here.** Implemented by `createWorkspaceIgnoreMatcher`
(`packages/utils/src/workspace-ignore-matcher.ts`):

| # | Source | Bypassed by `includeIgnored`? |
| --- | --- | --- |
| 1 | global excludes (`core.excludesFile`) | yes |
| 2 | `.git/info/exclude` | yes |
| 3 | parent `.gitignore` chain (root inside a larger repo) | yes |
| 4 | `.gitignore` (root, then nested — deeper wins) | yes |
| 5 | `.ignore` ("hide from search, keep in git") | yes |
| 6 | `.rgignore` | yes |
| 7 | `.llmignore` (portable agent ignore file) | **NO — HARD** |
| 8 | `.brainstrikeignore` (ours; wins over the portable one) | **NO — HARD** |

**Layer groups resolve GLOBALLY; nesting resolves within a group.** Outermost
scope first inside each group (deeper wins — ripgrep's model), but every
bypassable scope is resolved before any hard one. A scope-major fold made the
agent layers bypassable by anyone who could add a nested `.gitignore` carrying
`!key.ts`, which is the opposite of what they are sold as.

**Sources that share a base compile into ONE matcher; sources based elsewhere
get their own scope with a `pathPrefix`.** Parent `.gitignore`s are anchored at
their own directory, so `workspace/vendor/` must be tested against
`workspace/vendor/x.ts`, not the `vendor/x.ts` the walk emits — concatenating
them into the root scope silently broke every slash-containing parent pattern.
Prefix rather than pattern-rewriting, because rebasing gitignore text means
reimplementing its syntax. The matcher evaluates every reachable directory
component plus the leaf through those scoped parsers (BST-1434), keeping each
containing component in one path-keyed state map. Cross-scope evaluation uses
`ignore@7.0.5`'s direct rule-manager verdict because public `test()` deliberately
returns an ignored parent's cached result for descendants; silently accepting a
different dependency shape is forbidden. This preserves separately excluded
ancestors, descendant-specific rules hidden behind a parent match, and repeated
unanchored matches after a deeper scope re-includes only the first directory.
The ordinary single-root case avoids the path-keyed map but still evaluates each
component directly so its cross-group semantics cannot differ from the scoped
path. Direct verdicts are memoized per immutable compiled matcher, recovering
the ancestor-query cache that public `test()` would otherwise provide.
Leaf-only negations still cannot bypass an ignored parent directory.

> CORRECTED 2026-09-21: the workspace catalog pins `ignore` 7.0.8, not 7.0.5.
> The version in `workspace-ignore-matcher.ts`'s comment and error string is
> stale too; the direct rule-manager verdict it depends on still exists in
> 7.0.8, so only the number is wrong.

**`.git/info/exclude` is resolved through `git rev-parse --git-path`**, not
`<repo>/.git/info/exclude`. In a linked worktree or submodule `.git` is a FILE,
so the naive path does not exist and the layer silently vanishes — on a repo
where worktrees are routine.

**`core.excludesFile` is read with `cwd` at the workspace root**, and memoised
per root. Without `cwd`, `git config --get` merges the LOCAL config of whatever
directory Electron main was launched from.

**THE AGENT LAYERS ARE A HARD BOUNDARY (7-8) — do not relitigate.**
`includeIgnored` bypasses every other layer, because tools legitimately search
excluded trees. It does not bypass these. They are the only exclusion a user may
reasonably treat as a security control (credentials, customer data, a private
corpus), and a promise of "never read, index, or send" that one flag defeats is
worse than no promise, because people rely on it. Consequences that follow and
must be preserved:

- The walk asks the matcher FIRST and ALWAYS; `includeIgnored` short-circuits
  only the static policy floor beneath it.
- **`respectGitignore` does not gate them either.** It controls which BYPASSABLE
  layers are COLLECTED; the matcher is always constructed and the agent files
  always read. Gating them on a flag named for `.gitignore` was the same master
  key one level up, and `walkWorkspaceRoot` is exported — the next caller that
  omits the flag would inherit a walk with no hard boundary and no signal it
  lost one.
- **The verdict is evaluated on the file that gets READ, not the path that was
  requested.** `resolveWorkspaceAbsolutePath` returns the realpath'd target and
  the normalized request as separate fields; checking the request let an
  ordinary in-root symlink (`notes/leak.md -> ../secrets/api-key.env`) pass
  containment, be asked about under its alias, and be read from its target.
  Aliasing, not retargeting — the stable-path lock does not help. Every read
  path checks both, and the walk checks a symlink's canonical target before
  recording it.
- **The agent layers are INHERITED from parent directories**, up to the
  enclosing repository root, in the walk AND in `createAgentIgnoreGuard` — via
  the shared `repository-root.ts` so the two cannot drift. A repo-root
  `.llmignore` is the normal way a team ships one; reading only `.gitignore`
  from parents meant it did nothing once a subdirectory was opened as a root
  (BST-1436). Repo-root discovery is unconditional (a stat walk); the
  `git config` subprocesses stay gated on `respectGitignore`.
- **NO PROCESS-WIDE GUARD CACHE.** One existed for a release and is deliberately
  gone. It saved mostly-ENOENT opens and cost the primary user story: a rule
  written AFTER the first query was invisible until restart. "It cannot loosen
  on its own" is the wrong safety property — TIGHTENING is what the user is
  doing. Batch callers share one guard per operation, which bounds staleness to
  a single tool call.
- **An unreadable agent ignore file FAILS CLOSED — in the WALK as well as the
  guard.** This inverts the rule for
  every other layer, where failing open costs only a wider walk. Here, "I could
  not read the rules" resolving to "there are no rules" serves the protected
  file — the exact outcome the boundary exists to prevent, arriving through the
  door marked robustness. ENOENT is the only quiet failure.

  > CORRECTED 2026-09-21: absence is quiet for ENOENT, ENOTDIR and EISDIR —
  > `isAbsentErrorCode` in `workspace-file-walk.ts` and `isAbsent` in
  > `agent-ignore-guard.ts`. Every other error code still throws, so the
  > fail-closed rule itself is unchanged.
- **Never fold verdicts across layers by hand.** Layers are concatenated in
  precedence order into ONE `ignore` instance per group. A separate instance per
  layer forces the caller to combine verdicts, and that combination is wrong
  wherever a directory-only pattern meets its negation: for `cache/one.md` under
  `.gitignore: cache/` plus `.ignore: !cache/`, the layers report
  `{ignored:true}` and `{}`, so any fold keeps the file excluded — while
  `git check-ignore` does not. Hand the ordered patterns to the parser.

- **Why gitignore leads.** A hand-maintained denylist of directory names cannot
  keep up with machine-local caches, and when it falls behind the failure is
  SILENT: a glob returns `0 matches`, not an error. Every directory that has
  actually hurt us was already gitignored — `.pnpm-store` (82,267 files here,
  1.6x the 50,000 walk cap on its own; BST-1428), `.turbo`, `.claude/worktrees`
  — and two of the three still needed a bespoke list entry. Respecting
  `.gitignore` is what ripgrep, fd, VS Code, ESLint and Prettier all do.
- **Why the floor stays.** A root that is not a git repo has no `.gitignore`,
  and `.git` itself is never gitignored. The static policy carries those alone.
- **DIRECTORIES MUST BE TESTED WITH A TRAILING SLASH** — do not relitigate. A
  directory-only pattern (`dist/`) does NOT match the bare path `dist`, because
  a bare path carries no directory signal. Asking the file form when deciding
  whether to descend returns false, the walk enters the tree, and it then
  rejects every file inside one at a time — which is the cap starvation this
  exists to prevent. `createWorkspaceIgnoreMatcher` therefore exposes `ignoresDirectory`
  and `ignoresFile` as separate methods rather than one convenience call.
- **Nested `.gitignore` files scope to their own subtree**, pushed on entry and
  popped on exit, outermost-first so a deeper file can re-include what an outer
  one ignored (git resolves last-match-wins). The presence check reuses the
  directory listing the walk already has, so directories without one cost
  nothing.
- **Implementation is the `ignore` package**, chosen deliberately and pinned by
  `workspace-ignore-matcher.test.ts`: gitignore reimplementations disagree on
  edge cases, so the behaviour depended on is asserted rather than assumed.
- **LIVE GREP DELIBERATELY DOES NOT OPT IN.** Its ripgrep pass runs
  `--no-ignore --hidden` so rg is a true SUPERSET and `policy.shouldIncludeFile`
  stays the SINGLE authority trimming both engines identically — otherwise
  results differ by whether rg is installed. Honouring `.gitignore` on the JS
  side alone breaks that parity (the `rg-vs-walk parity` case catches it);
  honouring it on both would require rg's Rust implementation and the `ignore`
  package to agree on every edge case. Making grep gitignore-aware is its own
  change: BST-1429. THE AGENT LAYERS ARE THE EXCEPTION — see below.
- Measured on this repo, walking with the FULL chain: `scanned` 6,739 → 5,560
  and `kept` 5,147 → 4,998, at 92ms → 151ms. (BST-1427 measured 88ms → 111ms
  with `.gitignore` alone.) The extra ~40ms is dominated by the one-time
  `git config --get core.excludesFile` subprocess at root-chain assembly, not by
  per-directory reads — `readDirectoryIgnoreSources` only opens names actually
  present in the listing the walk already has, so a directory declaring no
  ignore files costs a few Set lookups.