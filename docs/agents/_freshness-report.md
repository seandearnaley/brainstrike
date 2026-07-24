# Agent-contract freshness report

Audited revision: `27814cbd3f5b45796e7d65dc64dfb23151eb3783`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 0 | ACCURATE |
| docs/agents/assistant-persistence.md | 287 | ACCURATE |
| docs/agents/assistant-providers.md | 331 | ACCURATE |
| docs/agents/assistant-runtime.md | 474 | ACCURATE |
| docs/agents/assistant-subagents.md | 87 | ACCURATE |
| docs/agents/ci-quality.md | 192 | ACCURATE |
| docs/agents/database.md | 65 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 139 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/platform-contracts.md | 23 | ACCURATE |
| docs/agents/ui-conventions.md | 50 | ACCURATE |
| docs/agents/workspace-context.md | 278 | ACCURATE |

The deterministic scan verified 1,974 checkable references against the audited
revision with no dangling paths, migration references, or package-script commands.
Manual review of the contracts changed since the prior Scribe watermark verified the
critical-tool partition, projector replay handling, workspace-root convergence, and
CI runner assignments against their source and stated test seams. No factual drift or
code/test contract conflict was found.
