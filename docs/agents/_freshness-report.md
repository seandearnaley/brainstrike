# Agent-contract freshness report

> **Point-in-time audit artifact—not a current health signal or routing index.**
> The statuses below apply only to the audited revision. For current work, route
> from `AGENTS.md`, search the relevant contract, and verify its claims against
> current source and tests.

Audited revision: `16ca56bc383c117107d16df073b5cb5d483abf74`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 4 | ACCURATE |
| docs/agents/agent-self-query.md | 144 | ACCURATE |
| docs/agents/assistant-persistence.md | 455 | ACCURATE |
| docs/agents/assistant-providers.md | 473 | ACCURATE |
| docs/agents/assistant-runtime.md | 840 | ACCURATE |
| docs/agents/assistant-subagents.md | 106 | ACCURATE |
| docs/agents/ci-quality.md | 484 | ACCURATE |
| docs/agents/code-execution.md | 223 | ACCURATE |
| docs/agents/database.md | 96 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 141 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/mastra-boundary.md | 223 | ACCURATE |
| docs/agents/platform-contracts.md | 458 | ACCURATE |
| docs/agents/ui-conventions.md | 74 | ACCURATE |
| docs/agents/workspace-context.md | 308 | ACCURATE |

The deterministic scan verified 4,077 checkable references against the audited
revision, including the four references in the prior freshness report. Manual
review confirmed the two optional, intentionally untracked desktop credential
files (`apps/desktop/.env.local` and `apps/desktop/.env`),
the generic `X` command examples, the documented negative pnpm examples, and
the remaining generic path placeholders.
All project paths, anchors, migration numbers, package scripts, and
paired-test declarations resolved at the audited revision.

Mechanical corrections in this sweep retargeted the local-runtime receiver-test
reference to its current package and shortened the Hosted Web route anchor to its
live end.
No code-versus-test contract conflict was found.
