# Agent contracts

Each page holds the non-obvious invariants for one subsystem; read the one your
task touches.

- Root `AGENTS.md` owns working rules and delivery policy; accepted decisions
  live in `docs/adr/`.
- Verify details against current source and tests.

| Working on | Contract |
| --- | --- |
| Run admission, streaming and Stop | [Runtime](assistant-runtime.md) |
| Logs, hydration and accounting | [Persistence](assistant-persistence.md) |
| Providers, credentials and MCP | [Providers](assistant-providers.md), [provider cassettes](provider-cassettes.md) |
| Child runs and parent continuation | [Subagents](assistant-subagents.md) |
| Agent eval tasks | [Evals](agent-evals.md) |
| Canonical SQLite state, its search index and root lease | [StateStore](state-store.md), [host lease](host-lease.md) |
| Workspace instructions, roots and edits | [Workspace](workspace-context.md) |
| Explorer, search and the thread context map | [Explorer](explorer-search-context-map.md) |
| Git changes and managed worktrees | [Changesets](changeset-diff.md) |
| Shared UI, menus and reload | [UI](ui-conventions.md) |
| IPC, logging, reset and quit | [Platform](platform-contracts.md), [diagnostics privacy](../diagnostics-privacy-contract.md) |
| Sandboxed code execution | [Execution](code-execution.md) |
| Effect and Mastra boundaries | [Effect](effect-boundary.md), [Effect Schema](effect-schema-migration.md), [Mastra](mastra-boundary.md) |
| MCP protocol qualification | [Conformance](mcp-conformance.md) |
| Secret scanning | [Secret scanning](../security/secret-scanning.md) |
| Tickets and project vocabulary | [Tracker](issue-tracker.md), [triage](triage-labels.md), [domain](domain.md) |

Writing these pages:

- Keep each contract to about a page of nested lists: ownership, security,
  durability and lifetime constraints.
- API inventories, pins, limits and command recipes belong to their executable owners.
- Resolved incidents and measurements belong in PRs and commit history, not here.
- Update a page when its meaning changes, not as a routine PR step.
