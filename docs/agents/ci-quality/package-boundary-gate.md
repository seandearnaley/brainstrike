# The package-boundary gate — evidence

Supports `docs/agents/ci-quality.md` § "The package-boundary gate" (BST-967).
Read this before changing `scripts/turbo-boundaries.mjs`, the Static step
order, or on every Turbo version bump. The contract holds the rules; this file
is the record of why the wrapper exists and why git decides.

The `Static` job runs `pnpm run boundaries` as its first substantive step
(right after the secret scan). That script, `scripts/turbo-boundaries.mjs`,
runs the real `turbo boundaries` and then judges only the findings in files
git does not ignore.

**Why the wrapper exists.** The analyzer walks every package directory and its
only exclusion is `node_modules/**`: it reads `dist/` and every other emitted
output, and it does not consult `.gitignore`. There is no way to narrow the
walk — no CLI flag, no `turbo.json` key, no `.turboignore` — verified against
turbo 2.10.8, 2.10.10, and 2.10.11-canary.3 (`--ignore` only offers to WRITE
`@boundaries-ignore` comments into the files it scanned, which is useless for
output regenerated on every build). Recheck that on the next Turbo bump — if
the walk becomes configurable, the wrapper should shrink to that config. So
the raw command is not idempotent on a developer machine: green on a clean
tree, then red on the identical tree once anything has built, over files
nobody wrote — `dist/turso/*` from an unmerged branch flagging a dependency no
source on `main` imports; `apps/web/dist/assets/chunking.worker-*.ts` flagged
for `@brainstrike/tokenization`. CI never saw it (fresh checkout, and the
ordering below), which is exactly what let it sit.

**Why git decides.** A hardcoded list of output directories would drift, and
turbo's own `outputs` cannot serve as one: `packages/config` declares
`tsconfig/**`, `biome/**`, and `tailwind/**` as build outputs and those are
SOURCE. `git check-ignore` is index-aware, so a checked-in file is judged even
if it matches an ignore pattern, and an uncommitted source file is judged too.
That index-awareness is also what keeps this safe as a CI gate: on the fresh
checkout Static runs against, every file a PR touches is TRACKED, so no
contributor can suppress a finding by adding a `.gitignore` entry — the gate
filters generated output, never repository content.
Suppression applies ONLY to a finding whose file git confirms is ignored;
everything else fails the gate, including a diagnostic with no file location, a
turbo issue count the parser cannot account for, and git itself erroring. One
stated local-vs-CI difference: personal excludes (`~/.config/git/ignore`,
`.git/info/exclude`) count as ignored locally, so CI stays the stricter side.

**The ordering is now about cost, not correctness.** Keep the step ahead of
anything that materializes `dist/` — `type-check` (whose turbo task
`dependsOn: ["build"]`), any `pnpm build`, or a cache restore of real build
outputs — because a clean tree is roughly half the files to scan (~4,000 vs
~8,000 here). It is no longer what makes the verdict trustworthy.

Deliberate crossings carry inline `// @boundaries-ignore <reason>` comments at
the import site. The contract tests in
`scripts/__tests__/turbo-boundaries-gate.test.mjs` keep all of this honest:
they prove the gate can fail (fixture workspace with a violation → non-zero
exit, clean fixture → zero), that a violation living only in git-ignored build
output passes while raw `turbo boundaries` on the same fixture fails, that
build output cannot MASK a source violation, that a TRACKED file under `dist/`
is still judged, assert the Static step stays ordered before any dist-producing
step, and require every ignore comment to carry a substantive reason. Division
of labor with the custom checker:
`architecture-domain-boundaries.mjs` owns cross-DOMAIN direction rules; `turbo
boundaries` owns package-escaping imports and undeclared dependencies. Known
blind spots (tracked, not solved here): CLI-flag dependencies such as the
coverage provider (BST-1017) and non-import reaches via `fileURLToPath` are
invisible to the analyzer.

The analyzer's reach widens across Turbo patch releases, so a Turbo bump can
surface a pre-existing crossing with no source change: 2.10.8 reports
`packages/chunking-worker/bench/tree-sitter-cost.mjs`'s relative
`../../text-splitter/src/index.ts` dynamic import, which 2.10.5 did not (same
tree, same 3705 files / 50 packages — 2.10.5 clean, 2.10.8 one issue). That one
is annotated, not rewritten: the bench must measure current text-splitter
SOURCE, and `@brainstrike/text-splitter` exports only `./dist`, so the package
specifier would silently benchmark a stale build. Expect to triage new findings
this way on the next bump rather than assuming the tree regressed.

## 2026-09-28: 2.11.4 rejected; 2.11.2 qualified

The unchanged boundary suite passed all 12 tests with 2.10.12. With the
2.11.4 binary it passed nine and failed three. Two failures reflect the new
vendor exclusion of ignored generated output. The third is the substantive
regression: `git add -f packages/alpha/dist/index.js` makes the undeclared import
repository source, but 2.11.4 omits it and reports no issues. The wrapper exits
zero because it receives no finding to classify. Its index-aware git check
cannot restore a diagnostic that never arrived.

[Upstream #14137](https://github.com/vercel/turborepo/pull/14137), introduced
in [2.11.3](https://github.com/vercel/turborepo/releases/tag/v2.11.3), intersects
candidate files with an ignore walker without consulting Git's index. This
explains the observed 2.11.4 failure; 2.11.3 itself was not executed here.
The inspected 2.11.4 documentation, CLI help, tagged source and boundary
configuration expose no include-tracked or equivalent remedy. The contract
holds >=2.11.3 until a vendor remedy passes the actual tracked-source control
while ignored generated output remains excluded. Keep the wrapper and all
existing assertions; do not rewrite ignore rules or suppress this test.

[2.11.2](https://github.com/vercel/turborepo/releases/tag/v2.11.2) is the last
stable release before that change. Its paired exact root pin and schema, plus
seven vendor package records and seven snapshots, preserve every other entry
in the complete baseline graph and the byte-identical workspace. Ordinary
full nonfrozen acceptance explicitly skipped resolution and kept the prepared
lock bytes; frozen acceptance also passed. The unchanged boundary suite passed
all 12 tests. All 56 configuration, real persistent-concurrency, worktree cache
collision, SCM locality, shard and native uncached guards passed. The complete
49 advisory records remained identical; production audit stayed zero.

The paired tracked-source test now also requires the raw vendor command to
report the undeclared import before checking the wrapper. This names the
condition that must hold before removing the release hold. No version-string
test, weaker assertion, vendor patch or alternative checker is introduced.
Required PR CI, completed review and actual postmerge proof remain separate
delivery gates.
