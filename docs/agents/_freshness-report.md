# Agent-contract freshness report

Audited revision: `9c177e5c8818d52c22e05f2a6ddf504f1ed80dea`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 0 | ACCURATE |
| docs/agents/assistant-persistence.md | 337 | ACCURATE |
| docs/agents/assistant-providers.md | 381 | ACCURATE |
| docs/agents/assistant-runtime.md | 511 | ACCURATE |
| docs/agents/assistant-subagents.md | 87 | ACCURATE |
| docs/agents/ci-quality.md | 228 | ACCURATE |
| docs/agents/database.md | 65 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 139 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/mastra-boundary.md | 190 | ACCURATE |
| docs/agents/platform-contracts.md | 253 | ACCURATE |
| docs/agents/ui-conventions.md | 50 | ACCURATE |
| docs/agents/workspace-context.md | 291 | ACCURATE |

The deterministic scan verified 2,580 checkable references against the audited
revision with no dangling paths, migration references, or package-script commands.
The collector validates anchored project paths against their file lengths, records
bare filename anchors, and surfaces context-only anchors for manual review.
Manual review of the contracts changed since the prior Scribe watermark verified the
run-id schema-provenance, durable reasoning/replay, provider output-limit,
tsup/coverage, workflow-snapshot reset/diagnostics, and Mastra-boundary rulings with
their stated test seams. No factual drift or code/test contract conflict was found.
