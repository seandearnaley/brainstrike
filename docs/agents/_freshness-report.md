# Agent-contract freshness report

Audited revision: `f190b4e1790b785c9bc40a82bf04cd8972e09585`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 0 | ACCURATE |
| docs/agents/assistant-persistence.md | 298 | ACCURATE |
| docs/agents/assistant-providers.md | 336 | ACCURATE |
| docs/agents/assistant-runtime.md | 483 | ACCURATE |
| docs/agents/assistant-subagents.md | 87 | ACCURATE |
| docs/agents/ci-quality.md | 192 | ACCURATE |
| docs/agents/database.md | 65 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 139 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/platform-contracts.md | 23 | ACCURATE |
| docs/agents/ui-conventions.md | 50 | ACCURATE |
| docs/agents/workspace-context.md | 291 | ACCURATE |

The deterministic scan verified 2,012 checkable references against the audited
revision with no dangling paths, migration references, or package-script commands.
Manual review of the contracts changed since the prior Scribe watermark verified the
typed skill-script tool, stream-insulation boundary, thread-root binding, and their
stated test seams. No factual drift or code/test contract conflict was found.
