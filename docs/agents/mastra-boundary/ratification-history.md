# Why this boundary is written down — evidence

Supports `docs/agents/mastra-boundary.md` § "SCOPE AND STATUS". Read this before
reopening a ruling or wondering why a ratification needed a document at all. The
contract holds the rulings; this file is the record of the four deferrals behind
them and the original NEW/ratifies classification. Version note: the audit was
written against `@mastra/core@1.64.0` + `@mastra/memory@1.28.2`, the pins still
installed today.

Settled rulings for how Brainstrike consumes Mastra. Read this before adding a
`@mastra/*` package, before registering anything new on the `Mastra` instance, and
before moving any Brainstrike-owned surface behind a Mastra one.

Closes the architecture gate that BST-557, BST-558, BST-559, BST-560, and BST-561
each deferred to. The historical audit those tickets cite now lives at
`docs/archive/mastra-agent-system-docs-catch-up-2026-05-29.md` (moved by BST-750,
#1963); it recorded the deferral, never a decision.

Verified against `@mastra/core@1.64.0` and `@mastra/memory@1.28.2` — the only
installed `@mastra/*` packages (`@mastra/schema-compat@1.3.8` is transitive).



Every ruling below is **ratification of shipped behavior** unless marked NEW. The
audit found no place where current code contradicts the chosen boundary, so
closing this gate required no migration. What was missing was the written record
and its guards — which is why the same decision evaporated across sessions and
was re-deferred four times between 2026-05-30 and 2026-07-24.

| # | Ruling | Kind |
| --- | --- | --- |
| R1 | Mastra is an embedded library runtime; Brainstrike owns all HTTP | ratifies |
| R2 | `@mastra/core` is Node-only; never in a browser bundle | **NEW** |
| R3 | Brainstrike workspace tools are authoritative | ratifies |
| R4 | Browser-driving agents are out of scope | ratifies |
| R5 | `RuntimeData` is authoritative; RequestContext carries Mastra keys only | ratifies |
| R6 | Brainstrike `StreamChunk` is the UI/persistence contract | ratifies + **NEW** unknown-chunk policy |
| R7 | MCP uses the official SDK only | cross-reference to an existing ruling |
| R8 | Brainstrike owns observability; evals are NOT gated on this boundary | ratifies + **corrects** BST-561 |
| R9 | Workflow snapshots are resume state, not app state | ratifies |
| R10 | Prompt Workbench owns prompt/version state | ratifies, with a corrected rationale |

