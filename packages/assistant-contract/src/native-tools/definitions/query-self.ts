import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { QuerySelfInputSchema } from '../schemas/schemas-diagnostics.js';

/**
 * Worked example queries embedded in the `querySelf` description.
 *
 * Exported as a constant rather than prose so a test can EXECUTE them against a
 * migrated database (`packages/db/__tests__/agent-sql-service.test.ts`). A
 * broken example is worse than none — it teaches the model a column that does
 * not exist and costs it a turn — and this makes drift a build failure the day a
 * migration renames something, instead of a silent regression.
 *
 * Keep them short: this text is paid for on every request that loads the tool.
 */
export const QUERY_SELF_EXAMPLE_QUERIES: readonly string[] = [
  'SELECT path, count(*) AS reverts FROM brainstrike_assistant_edit_checkpoints WHERE reverted_at IS NOT NULL GROUP BY path ORDER BY reverts DESC',
];

// Read-only SQL over Brainstrike's OWN local database (run outcomes, edit
// checkpoints, usage, queue metrics, the code index). `riskCategory` is
// PINNED rather than derived: the input is arbitrary SQL, so a reader must
// see the bucket asserted at the declaration site. `read` is justified by the
// four engine-enforced sandbox layers in `AgentSqlService` — read-only
// transaction, non-superuser role, single-statement protocol, and EXPLAIN
// cost gate. See docs/agents/agent-self-query.md before changing this.
export const querySelf = defineNativeTool({
  defaults: {
    category: 'analysis',
    estimatedTokens: 260,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description: `Run ONE read-only SQL statement over Brainstrike's local stores. ALWAYS set target and mode: target app uses Postgres for assistant history, edit checkpoints, usage/cost and queue metrics; target index uses SQLite for the derived workspace code index (file_records, file_chunks), FTS5 search and symbol graph (file_symbols, file_symbol_refs). Start with listTables, then describeTable with table, then query or explain with sql. SQLite explain uses EXPLAIN QUERY PLAN and refuses analyze=true; app explain supports PostgreSQL EXPLAIN ANALYZE under its cost gate. Saved lenses (.brainstrike/lenses/*.sql): listLenses shows each declared target; invoke lens with that target, lens id and positional values. Example target app sql: ${QUERY_SELF_EXAMPLE_QUERIES[0]}. App plans above the cost ceiling are refused; index queries run in a dedicated read-only process with a deadline and bounded results. A missing index is an explicit capability error. Narrow expensive queries and retry. Catalog/stats views are available only in target app`,
  discovery: { family: 'DB self-query', namespace: 'database' },
  history: { recencyPrunable: true },
  id: 'brainstrike.querySelf',
  inputSchema: providerCompatibleInputSchema(QuerySelfInputSchema),
  kind: 'desktop',
  returns:
    'Column names once plus positional rows, row count and explicit truncation; app results also include their PostgreSQL planner cost. Schema modes return table or column listings; explain returns the selected engine plan; lens listings declare each target',
  surfaces: ['desktop'],
});
