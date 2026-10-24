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
- Local inference belongs in hidden renderer hosts, never Electron main.
  Shared code uses capabilities, not platform guesses. New durable state belongs
  in the existing reset lifecycle. See ADRs 0007, 0008 and 0015.
- The host owns the AI SDK run loop; Mastra is a memory library, not another
  server, permission system or persistence owner. Keep Node-only dependencies out
  of browser bundles. See ADRs 0011, 0012 and 0017.
- Use strict TypeScript and existing React/shared UI conventions. Effect runtime
  work follows `docs/agents/effect-boundary.md`; infer versions and build commands
  from the installed packages and scripts.

## Prefer removal

When an area keeps failing, change the design and prefer removing the mechanism
over patching it. Do not answer a failure with a new timer, retry, guard script,
contract test or rule. Tests assert behaviour a user would notice or a durable-data
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
  then `pnpm --filter <package> test`, then `pnpm test:affected`. Run the full
  `pnpm check` once, right before queueing, never as an edit loop.
- Never rerun a lane that passed. After a failure, rerun only the failing files.
- Start anything longer than about two minutes in the background and keep
  working; do not wait on it or poll it.
- Run independent work in parallel (separate processes, subagents or worktrees),
  and keep turbo and Vitest using the cores (`--concurrency`, Vitest workers).
- Time-box audits and investigations. Report what is known with its gaps rather
  than mapping everything first; the owner can ask for more.

## Validation and delivery

`pnpm check` must pass before a change is queued. Hosted CI runs nightly on main;
main lands only through Mergify's merge queue: enqueue with
`gh pr comment <number> --body '@mergifyio queue'`. Do not enable workflows,
dispatch hosted checks, request automated reviews, sign or publish without the
owner's authorization. Report actual checks and failures; never describe a
partial run as a full pass.

## Find specialist context when needed

| Area | Reference |
| --- | --- |
| Host, storage and indexing | [State store](docs/agents/state-store.md), [host lease](docs/agents/host-lease.md), [indexer](docs/agents/indexer.md); ADRs 0011, 0017, 0018 |
| Assistant runs, persistence, providers and MCP | [Runtime](docs/agents/assistant-runtime.md), [persistence](docs/agents/assistant-persistence.md), [providers](docs/agents/assistant-providers.md), [provider cassettes](docs/agents/provider-cassettes.md), [MCP](docs/agents/mcp-conformance.md) |
| UI and workspace behavior | [UI conventions](docs/agents/ui-conventions.md), [workspace context](docs/agents/workspace-context.md), [explorer, search and context map](docs/agents/explorer-search-context-map.md); ADR 0021 |
| Inference, execution and reset | [Local inference](docs/agents/local-inference.md), [code execution](docs/agents/code-execution.md), [platform contracts](docs/agents/platform-contracts.md) |
| Product tickets | [Issue tracker](docs/agents/issue-tracker.md); Linear is the product tracker |
