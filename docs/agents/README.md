# Agent contracts

These pages contain the non-obvious invariants for a subsystem. Use the relevant
page when the task needs it; there is no mandatory document-reading itinerary.
Root `AGENTS.md` owns working rules, [validation](ci-quality.md) owns delivery
policy, and accepted decisions live in `docs/adr/`. Verify implementation details
against current source and tests. Historical notes are reference, not more rules. Earlier records live in the
[contract history](../archive/agent-contract-history/README.md).

| Working on | Contract |
| --- | --- |
| Run admission, streaming and Stop | [Runtime](assistant-runtime.md) |
| Logs, hydration and memory | [Persistence](assistant-persistence.md) |
| Providers, credentials and MCP | [Providers](assistant-providers.md), [provider cassettes](provider-cassettes.md) |
| Child runs and parent continuation | [Subagents](assistant-subagents.md) |
| Canonical SQLite state and root lease | [StateStore](state-store.md), [host lease](host-lease.md) |
| Catalogs and remaining PGlite | [Database](database.md) |
| Derived search and indexing | [Indexer](indexer.md), [retrieval quality](retrieval-quality.md) |
| Embeddings and local LLM | [Local inference](local-inference.md) |
| Workspace instructions, roots and edits | [Workspace](workspace-context.md) |
| Explorer, search and the thread context map | [Explorer](explorer-search-context-map.md) |
| Git changes and managed worktrees | [Changesets](changeset-diff.md) |
| Shared UI, menus and reload | [UI](ui-conventions.md) |
| IPC, logging and reset | [Platform](platform-contracts.md) |
| Sandboxed code execution | [Execution](code-execution.md) |
| Effect and Mastra boundaries | [Effect](effect-boundary.md), [Mastra](mastra-boundary.md) |
| MCP protocol qualification | [Conformance](mcp-conformance.md) |
| Tickets and project vocabulary | [Tracker](issue-tracker.md), [triage](triage-labels.md), [domain](domain.md) |

Keep each contract roughly one page. Preserve current ownership, security,
durability and lifetime constraints. API inventories, pins, limits and command
recipes belong to their executable owners. Resolved incidents and measurements
belong in history; adding one does not create a new agent procedure. Change docs
when their meaning changes, not as a routine PR requirement.
