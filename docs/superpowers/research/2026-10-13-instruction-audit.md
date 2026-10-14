# Brainstrike instruction audit

Audit of `abd78dd82b4cc34831cfe093b43b5d71575044c6`, 13 October 2026.
Replacements were prepared on `codex/simplify-agent-rules` for this audit.

## Finding

The root and 25 top-level agent contracts contain **150,257 words**, with another
609 nested evidence/research files. That is not all automatically loaded, but root
instructions require entire contracts before changes in the listed areas.
`assistant-runtime.md` alone is 24,748 words. The CI page is 7,472 words across
1,061 lines. Four package instruction files add lengthy inventories and tutorials.

The problem is instruction authority and accumulated mandatory work, not just
file length. Current rules, implementation facts, disabled workflows, dated
milestone procedures and incident receipts are presented together as policy.

## Concrete problems

- Root requires full regression for every merge, while the CI page permits scoped
  checks and reuse. The agent can interpret the broader requirement as dominant.
- The CI page declares local-only validation, then describes required hosted MCP
  jobs, workflow dispatches, Claude reviews and CI artifact requirements. Its
  opening disclaimer does not make hundreds of later instructions easy to apply.
- The agent package says CI blocks merges and requires documenting every new tool
  in `AGENTS.md`. Root says CI is disabled and docs are not a per-PR tax.
- Package guides still describe the retired Mastra loop and renderer PGlite as
  the architecture. Newer ADRs distinguish the current host and shared web paths.
- Exact line-count rules, guard inventories, mandatory numbers of hypotheses,
  review rounds and milestone-specific stop rules turn incidents into permanent
  procedures. Many details already have an executable owner.

## Replacement

Keep three kinds of material distinct: **short working rules**, **architectural
decisions in ADRs**, and **technical/historical reference consulted when needed**.
The root and validation page each fit roughly one page. Package instructions
contain only local constraints; the already-short UI package guide stays intact.

| Draft | Before words | After words |
| --- | ---: | ---: |
| Root `AGENTS.md` | 1,686 | 477 |
| `docs/agents/ci-quality.md` | 7,472 | 418 |
| Agent package | 4,587 | 144 |
| App shell package | 2,963 | 122 |
| File explorer package | 2,214 | 124 |
| File explorer UI package | 3,351 | 133 |
| **Total** | **22,273** | **1,418** |

The six active pages shrink by about **93%**. Their original text remains available in Git at the audited commit; no extra
archive copies are added. Other
subsystem documents remain technical references; this is not a claim that all
150,257 words have been rewritten or verified against implementation.

The draft changes policy: validation depends on risk and changed behavior;
unchanged passing checks can be reused; docs-only changes do not trigger app
regression. Mechanical approval/measurement/receipt rituals give way to diagnosis
and escalation of actual ownership, engine or security decisions. Protected
profiles, visible failures, one durable owner, renderer-only inference, current
data lifecycle, CI authorization and honest acceptance remain.

Executable checks, thresholds, hooks, workflows, tests and ADRs are unchanged.
This simplification does not itself remove expensive or prose-checking guards
from tooling; auditing those is a separate code change. No app tests, SSH runs,
dependency installs or M6 implementation work were performed for this audit.

## Research and limits

[The primary-source research note](2026-10-13-agent-instructions.md) supports concise,
non-obvious rules and contextual specialist guidance. One page is the owner's
maintainability goal, not a proven optimum. Reduced instruction text is measured;
faster delivery or improved correctness is not yet demonstrated. Judge future
tasks by missed constraints, unnecessary reads and repeated validation, rather
than adding another document-length guard.

CI is disabled due to cost; validation must run locally. This documentation draft
was reviewed for scope, reference paths and whitespace; it does not qualify a
product or release.
