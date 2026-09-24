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
