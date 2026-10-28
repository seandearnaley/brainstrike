# Brainstrike

## Scope and authority

Work on a focused branch from current `main`; merge back to `main`. Keep at most
five open PRs. The owner's current request defines the outcome and scope.

Use code, tests and tool configuration for implementation details. Architectural
decisions live in `docs/adr/`; newer owner decisions supersede older ones.
Subsystem documents explain contracts and pitfalls: consult the relevant section
when needed. Package `AGENTS.md` files contain only additional local constraints.

## Constraints worth keeping

- Preserve one authoritative writer and identity for each durable fact. Reuse
  existing owners and vendor primitives; discuss ownership or engine changes with
  the owner before implementing them. Make failure visible; no silent fallback or
  weakened security boundary.
- Brainstrike is greenfield. Initialize the current schema and preserve fresh data
  across reopen, recovery, deletion and reset. Do not build legacy-data migrations
  or credential imports. Never access or reset Sean's protected profile; use
  disposable profiles and fake credentials for automation.
- Brainstrike runs no local models: chat and embeddings come from hosted
  providers. Shared code uses capabilities, not platform guesses. New durable
  state belongs in the existing reset lifecycle. See ADRs 0008 and 0015.
- The host owns the AI SDK run loop; Mastra is a memory library, not another
  server, permission system or persistence owner. Keep Node-only dependencies out
  of browser bundles. See ADRs 0011, 0012 and 0017.
- Strictest TypeScript settings stay on; never loosen a compiler flag to pass a
  check. Use existing React/shared UI conventions. Effect runtime
  work follows `docs/agents/effect-boundary.md`; infer versions and build commands
  from the installed packages and scripts.

## Internal packages are source-only

This is an owner rule. Every `@brainstrike/*` package is consumed as TypeScript
source through its `exports`; type-check reads source, and desktop bundles
workspace code at build time. Never add a `dist` build, `tsc -b` output, tsconfig
`paths`, project references or `composite` to an internal package. Never add a
workaround for built output either: no stale-`dist` pruning, dist loaders,
hardcoded fallbacks or alias registries. Never move a package back to `dist`, or
re-add a build edge, to make a failure pass; fix the root cause in source, the
test or the bundler config.

Only these may ship built output: the native add-ons (`secure-fs-native`,
`windows-job-native`), `mcp-test-lab` and `agent-evals`. Node runs every other
package's source directly with its built-in type stripping (Electron included),
so source stays erasable TypeScript and relative imports name the `.ts` file;
a worker or process entry beside a module takes that module's own extension.

## Prefer removal

When an area keeps failing, change the design and prefer removing the mechanism
over patching it. Never patch a patch: when a fix does not hold, revert it and fix
the design instead of stacking a second fix on the first. Do not answer a failure
with a new timer, retry, guard script, contract test or rule. Tests assert behaviour a user would notice or a durable-data
invariant, not internal call order or the text of other files.

## Time is the scarcest resource

Every developer and agent shares this machine's cores and the owner's wait.

**Caching and parallelism are never turned off.** This is an owner rule, not a
default. Every turbo task stays cacheable (only `dev` and `clean`, which turbo
cannot cache, are exempt), and no lane or package is made serial: no
`--concurrency=1`, no `maxWorkers: 1`, no `fileParallelism: false`, no
`cache: false`. A test that fails from the cache or in parallel is the defect.
Give it its own temporary directory, port, data root or clock, or declare the
missing input in turbo `inputs`/`env`. Never uncache or serialize to make it pass.

- Iterate on the narrowest check that covers the change: `vitest run <file>`,
  then `pnpm --filter <package> test`, then `pnpm test:affected`. The full
  `pnpm check` is optional before a PR and never an edit loop.
- Never rerun a lane that passed. After a failure, rerun only the failing files.
- Start anything longer than about two minutes in the background and keep
  working; do not wait on it or poll it.
- Run independent work in parallel (separate processes, subagents or worktrees),
  and keep turbo and Vitest using the cores (`--concurrency`, Vitest workers).
- Time-box audits and investigations. Report what is known with its gaps rather
  than mapping everything first; the owner can ask for more.

## Validation and delivery

The merge queue is the gate (owner decision 2026-10-27). Main lands only through
Mergify, and every queue batch runs every lane on hosted runners: lint,
type-check, unit, build, browser, smoke, packaged Electron and the full desktop
regression. Do not repeat that gate locally before a PR.

- Before opening a PR, run the narrow checks for what changed: lint, type-check
  and tests of the packages you touched (`pnpm test:affected`), plus the E2E
  specs for the feature you changed. Report exactly what ran.
- Open the PR ready for review, not as a draft, once those checks pass.
  Mergify queues every ready PR on its own, and the automated review runs
  while the queue does. Confirm the "Mergify Merge Queue" check is in
  progress; an unqueued PR with green CI never merges.
- Never wait for the automated review. If it reports a real defect before the
  PR merges, convert the PR to a draft (that dequeues it), fix it and mark it
  ready again.
- Keep a PR as a draft only while it depends on another open PR or awaits its
  Full Check. Mergify orders, batches and speculatively checks the rest.
- For a large or risky change, open the PR as a draft with the `full-check`
  label. The Full Check workflow then runs the queue's own lanes on the PR
  merged with main, on hosted runners, and again on each push while the label
  stays. Mark it ready once that run passes.
- A red batch is a finding. Fix this PR's failure and push, then confirm the
  "Mergify Merge Queue" check is in progress again. Fix a flaky test at its
  cause (it is never retried or skipped) and record it in Linear.

Do not enable other workflows, dispatch other hosted checks, request automated
reviews, sign or publish without the owner's authorization. Report actual checks
and failures; never describe a partial run as a full pass.

### Time budgets

A step that runs past its stop line is a defect to report, not a normal step.
Stop, tell the owner the measured time and its cause, and do not record the slow
path as a procedure.

| Step | Budget | Stop line |
| --- | --- | --- |
| One unit test file (`vitest run <file>`) | under 30 s | 1 min |
| One E2E spec | under 1 min | 2 min |
| One package's tests | under 2 min | 4 min |
| Narrow checks before a PR | 10 min | 20 min |
| Queue batch (the full gate) | 12 min | 20 min |
| Small fix, from report to merged | 45 min | 90 min |

## Find specialist context when needed

| Area | Reference |
| --- | --- |
| Host, storage and indexing | [State store](docs/agents/state-store.md), [host lease](docs/agents/host-lease.md), [indexer](docs/agents/indexer.md); ADRs 0011, 0017, 0018 |
| Assistant runs, persistence, providers and MCP | [Runtime](docs/agents/assistant-runtime.md), [persistence](docs/agents/assistant-persistence.md), [providers](docs/agents/assistant-providers.md), [provider cassettes](docs/agents/provider-cassettes.md), [MCP](docs/agents/mcp-conformance.md) |
| UI and workspace behavior | [UI conventions](docs/agents/ui-conventions.md), [workspace context](docs/agents/workspace-context.md), [explorer, search and context map](docs/agents/explorer-search-context-map.md); ADR 0021 |
| Execution and reset | [Code execution](docs/agents/code-execution.md), [platform contracts](docs/agents/platform-contracts.md) |
| Product tickets | [Issue tracker](docs/agents/issue-tracker.md); Linear is the product tracker |
