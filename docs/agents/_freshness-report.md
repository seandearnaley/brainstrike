# Agent-contract freshness report

Audited revision: `f584abf144735515a192e25069ffa23a10ce38fa`.

| Contract | Checkable references scanned | Status |
| --- | ---: | --- |
| docs/agents/_freshness-report.md | 0 | ACCURATE |
| docs/agents/agent-self-query.md | 142 | ACCURATE |
| docs/agents/assistant-persistence.md | 373 | ACCURATE |
| docs/agents/assistant-providers.md | 413 | ACCURATE |
| docs/agents/assistant-runtime.md | 715 | ACCURATE |
| docs/agents/assistant-subagents.md | 102 | ACCURATE |
| docs/agents/ci-quality.md | 269 | ACCURATE |
| docs/agents/database.md | 74 | ACCURATE |
| docs/agents/explorer-search-tapestry.md | 139 | ACCURATE |
| docs/agents/local-inference.md | 48 | ACCURATE |
| docs/agents/mastra-boundary.md | 204 | ACCURATE |
| docs/agents/platform-contracts.md | 371 | ACCURATE |
| docs/agents/ui-conventions.md | 54 | ACCURATE |
| docs/agents/workspace-context.md | 306 | ACCURATE |

The deterministic scan verified 3,210 checkable references against the audited
revision. It surfaced two paths in `assistant-providers.md` for manual review:
`apps/desktop/.env.local` and `apps/desktop/.env` are intentionally untracked,
optional runtime credential files (missing files are valid); their tracked
template is `apps/desktop/.env.example`, so both references are accurate.
The collector validates anchored project paths against their file lengths, records
bare filename anchors, and surfaces context-only anchors for manual review.
Manual review of the contracts changed since the prior Scribe watermark verified the
agent SQL sandbox, lens/persona scan contracts, durable provider failures,
thread presentation, CI coverage ratchets, reset/diagnostics, and Mastra-boundary
rulings with their stated test seams. No factual drift or code/test contract
conflict was found.
