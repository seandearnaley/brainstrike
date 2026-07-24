# Agent-contract freshness report

Audited revision: `c30fea0525d38329ee96950efd251285f912d2b9`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 1 | ACCURATE |
| docs/agents/assistant-persistence.md | 302 | ACCURATE |
| docs/agents/assistant-providers.md | 336 | ACCURATE |
| docs/agents/assistant-runtime.md | 483 | ACCURATE |
| docs/agents/assistant-subagents.md | 87 | ACCURATE |
| docs/agents/ci-quality.md | 194 | ACCURATE |
| docs/agents/database.md | 65 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 139 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/platform-contracts.md | 117 | ACCURATE |
| docs/agents/ui-conventions.md | 50 | ACCURATE |
| docs/agents/workspace-context.md | 291 | ACCURATE |

The deterministic scan verified 2,113 checkable references against the audited
revision with no dangling paths, migration references, or package-script commands.
Manual review of the contracts changed since the prior Scribe watermark verified the
durable root binding, persisted OpenAI tool references, usage-meter separation, and
Flight Recorder logging boundaries with their stated test seams. No factual drift or
code/test contract conflict was found.
