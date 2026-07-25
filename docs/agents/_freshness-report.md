# Agent-contract freshness report

Audited revision: `0413d6baef16c1d716987ad2d3ef880e247b5e09`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 0 | ACCURATE |
| docs/agents/assistant-persistence.md | 335 | ACCURATE |
| docs/agents/assistant-providers.md | 351 | ACCURATE |
| docs/agents/assistant-runtime.md | 509 | ACCURATE |
| docs/agents/assistant-subagents.md | 87 | ACCURATE |
| docs/agents/ci-quality.md | 229 | ACCURATE |
| docs/agents/database.md | 65 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 139 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/mastra-boundary.md | 158 | ACCURATE |
| docs/agents/platform-contracts.md | 153 | ACCURATE |
| docs/agents/ui-conventions.md | 50 | ACCURATE |
| docs/agents/workspace-context.md | 291 | ACCURATE |

The deterministic scan verified 2,415 checkable references against the audited
revision with no dangling paths, migration references, or package-script commands.
The collector also recognizes source-line ranges as citations rather than filenames.
Manual review of the contracts changed since the prior Scribe watermark verified the
run-id schema-provenance, durable reasoning/replay, provider output-limit,
tsup/coverage, workflow-snapshot reset/diagnostics, and Mastra-boundary rulings with
their stated test seams. No factual drift or code/test contract conflict was found.
