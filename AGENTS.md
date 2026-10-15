# Brainstrike

## Scope and authority

Work on a focused branch from current `main`; merge back to `main`. Keep at most
five open PRs. The owner's current request defines the outcome and scope.

Use code, tests and tool configuration for implementation details. Architectural
decisions live in `docs/adr/`; newer owner decisions supersede older ones.
Subsystem documents explain contracts and pitfalls: consult the relevant section
when needed, rather than reading a document stack before every change. Historical
plans and receipts do not create new acceptance requirements. Package `AGENTS.md`
files contain only additional local constraints.

## Constraints worth keeping

- Preserve one authoritative writer and identity for each durable fact. Reuse
  existing owners and vendor primitives; discuss ownership or engine changes with
  the owner before implementing them. Diagnose repeated failures before patching
  again. Make failure visible; no silent fallback or weakened security boundary.
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

## Validation and delivery

Choose checks for the changed behavior and its risk. Reproduce a bug before fixing
it; add a regression test when it protects meaningful behavior. Demonstrate
user-facing changes through the actual app flow. Documentation edits do not need
an application regression campaign. Follow [validation guidance](docs/agents/ci-quality.md).

CI is disabled due to cost; validation must run locally. Do not enable workflows,
dispatch hosted checks, request automated reviews, sign or publish without the
owner's authorization. Report actual checks, failures and omitted coverage; never
describe a partial run as a full pass. Use normal hooks and preserve failing tests.

Update documentation when a durable decision or user-facing contract changes,
not as a routine PR requirement. Keep rules short; put operational detail in its
own source and historical evidence in `docs/archive/`.

## Find specialist context when needed

| Area | Reference |
| --- | --- |
| Host, storage and indexing | [State store](docs/agents/state-store.md), [host lease](docs/agents/host-lease.md), [indexer](docs/agents/indexer.md); ADRs 0011, 0017, 0018 |
| Assistant runs, persistence, providers and MCP | [Runtime](docs/agents/assistant-runtime.md), [persistence](docs/agents/assistant-persistence.md), [providers](docs/agents/assistant-providers.md), [MCP](docs/agents/mcp-conformance.md) |
| UI and workspace behavior | [UI conventions](docs/agents/ui-conventions.md), [workspace context](docs/agents/workspace-context.md), [explorer, search and context map](docs/agents/explorer-search-context-map.md); ADR 0021 |
| Inference, execution and reset | [Local inference](docs/agents/local-inference.md), [code execution](docs/agents/code-execution.md), [platform contracts](docs/agents/platform-contracts.md) |
| Product tickets | [Issue tracker](docs/agents/issue-tracker.md); Linear is the product tracker |
