# Brainstrike

## Scope and authority

- Work on a focused branch from current `main`; merge back to `main`. Keep at most five open PRs.
- The owner's current request defines the outcome and scope.
- Sources of truth:
  - Implementation details: code, tests and tool configuration.
  - Architecture: `docs/adr/`. Newer owner decisions supersede older ones.
  - Subsystem contracts and pitfalls: `docs/agents/` (see the table at the end).
  - Package `AGENTS.md` files add local constraints only.

## Constraints

- One authoritative writer and identity for each durable fact.
  - Reuse existing owners and vendor primitives.
  - Discuss ownership or engine changes with the owner before implementing them.
  - Make failure visible: no silent fallback, no weakened security boundary.
- Brainstrike is greenfield.
  - Initialize the current schema; preserve fresh data across reopen, recovery, deletion and reset.
  - No legacy-data migrations or credential imports.
  - Never access or reset Sean's protected profile. Automation uses disposable profiles and fake credentials.
- No local models: chat and embeddings come from hosted providers.
  - Shared code gates on injected capabilities, not platform guesses (ADR-0008).
  - New durable state joins the existing reset lifecycle (ADR-0015).
- The host owns the AI SDK run loop and a thread's context; its compaction is the only thing that replaces history. Mastra supplies narrow utilities (tool search, skills, OpenRouter routing), never memory, another server, permission system or persistence owner (ADRs 0011, 0012, 0017, 0039).
  - Keep Node-only dependencies out of browser bundles.
- Strictest TypeScript settings stay on; never loosen a compiler flag to pass a check.
  - Follow existing React and shared UI conventions.
  - Effect runtime work follows `docs/agents/effect-boundary.md`.

## Internal packages are source-only (owner rule)

- Every `@brainstrike/*` package is consumed as TypeScript source through its `exports`. Type-check reads source; desktop bundles workspace code at build time.
- Never add to an internal package: a `dist` build, `tsc -b` output, tsconfig `paths`, project references or `composite`.
- Never add workarounds for built output: no stale-`dist` pruning, dist loaders, hardcoded fallbacks or alias registries.
- Never move a package back to `dist` or re-add a build edge to make a failure pass; fix the root cause in source, the test or the bundler config.
- Only these ship built output: `secure-fs-native` and `windows-job-native` (native add-ons), `mcp-test-lab` and `agent-evals`.
- Node runs every other package's source directly with built-in type stripping (Electron included):
  - Source stays erasable TypeScript.
  - Relative imports name the `.ts` file; a worker or process entry beside a module takes that module's extension.

## Prefer removal

- When an area keeps failing, change the design; prefer removing the mechanism over patching it.
- Never patch a patch: if a fix does not hold, revert it and fix the design.
- Do not answer a failure with a new timer, retry, guard script, contract test or rule.
- Tests assert behaviour a user would notice or a durable-data invariant, not internal call order or the text of other files.

## Time is the scarcest resource

Every developer and agent shares this machine's cores and the owner's wait.

- **Caching and parallelism are never turned off (owner rule).**
  - Every turbo task stays cacheable; only `dev` and `clean` are exempt.
  - No lane or package is made serial: no `--concurrency=1`, `maxWorkers: 1`, `fileParallelism: false` or `cache: false`.
  - A test that fails from the cache or in parallel is the defect. Give it its own temp directory, port, data root or clock, or declare the missing input in turbo `inputs`/`env`. Never uncache or serialize to make it pass.
- Iterate on the narrowest check: `vitest run <file>`, then `pnpm --filter <package> test`, then `pnpm test:affected`.
  - `pnpm check` is optional before a PR and never an edit loop.
- Never rerun a lane that passed; after a failure rerun only the failing files.
- Run anything longer than about two minutes in the background; don't wait on or poll it.
- Run independent work in parallel (processes, subagents, worktrees), and keep turbo and Vitest using the cores.
- Time-box audits; report what is known with its gaps.

## Validation and delivery

The merge queue is the gate (owner decision 2026-10-27). `main` lands only through Mergify, and every queue batch runs every lane on hosted runners (lint, type-check, unit, build, browser, smoke, packaged Electron, full desktop regression). Do not repeat that gate locally.

- Before opening a PR:
  - Run lint, type-check and tests for the packages you touched (`pnpm test:affected`), plus the E2E specs for the feature you changed.
  - Report exactly what ran.
- Open the PR ready for review once those pass.
  - Mergify queues a ready PR by itself once Claude Review has run on its head and every review thread is resolved (`.mergify.yml`).
  - Confirm Mergify reports it queued (Merge Queue check in progress); an unqueued PR with green CI never merges.
  - The Mergify Merge Protections check names any open thread; a missing or failed Claude Review keeps the PR out, even when queued by hand.
  - To queue by hand (e.g. a fork PR), tick "Queue this pull request" in Mergify's comment or comment `@mergifyio queue`.
  - Agents using the GitHub connector or API must tick the box (edit `- [ ]` to `- [x]`); their queue comment arrives defanged and Mergify ignores it.
- Review threads (Claude, Codex or a person):
  - Fix with a push, or reply with why it stands, then resolve the thread; a reply alone doesn't resolve it.
  - Claude's follow-up review resolves its own threads, and Codex's, when it judges the push fixed them.
  - A thread posted after queueing holds the merge too, so a fix never needs a draft.
  - A failed Claude Review holds the PR: report it to the owner with its run; don't rerun it.
- Drafts:
  - Keep a PR a draft only while it depends on another open PR.
  - For a large or risky change, open a draft with the `full-check` label and mark it ready once Full Check passes (it runs the queue's lanes on the PR merged with main, again on each push).
- A red batch is a finding: fix this PR's failure and requeue. Fix a flaky test at its cause (never retry or skip it) and record it in Linear.
- Without owner authorization, do not enable other workflows, dispatch hosted checks, request automated reviews, sign or publish.
- Never describe a partial run as a full pass.

### Time budgets

A step past its stop line is a defect: stop, tell the owner the measured time and cause, and don't record the slow path as a procedure.

| Step | Budget | Stop line |
| --- | --- | --- |
| One unit test file (`vitest run <file>`) | under 30 s | 1 min |
| One E2E spec | under 1 min | 2 min |
| One package's tests | under 2 min | 4 min |
| Narrow checks before a PR | 10 min | 20 min |
| Queue batch (the full gate) | 12 min | 20 min |
| Small fix, from report to merged | 45 min | 90 min |

## Specialist context

| Area | Reference |
| --- | --- |
| Host and storage | [State store](docs/agents/state-store.md), [host lease](docs/agents/host-lease.md); ADRs 0011, 0017, 0035 |
| Assistant runs, persistence, providers and MCP | [Runtime](docs/agents/assistant-runtime.md), [persistence](docs/agents/assistant-persistence.md), [providers](docs/agents/assistant-providers.md), [provider cassettes](docs/agents/provider-cassettes.md), [MCP](docs/agents/mcp-conformance.md) |
| UI and workspace behavior | [UI conventions](docs/agents/ui-conventions.md), [workspace context](docs/agents/workspace-context.md), [explorer, search and context map](docs/agents/explorer-search-context-map.md); ADR 0021 |
| Execution and reset | [Code execution](docs/agents/code-execution.md), [platform contracts](docs/agents/platform-contracts.md) |
| Product tickets | [Issue tracker](docs/agents/issue-tracker.md); Linear is the product tracker |
