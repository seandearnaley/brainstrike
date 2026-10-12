import { z } from 'zod';
import { QUERY_SELF_TARGETS } from '../../lenses.js';

// ============================================================================
// Query Self Tool Schema
// ============================================================================

/**
 * `brainstrike.querySelf` — one read-only SQL statement, or a schema lookup.
 *
 * `mode` is REQUIRED and is the single source of truth for intent. This shape is
 * deliberate and was learned the hard way: the first version used optional
 * `sql`/`describe` fields made mutually exclusive by a `.refine()`, and it was
 * BROKEN in production. Providers using strict function calling (OpenAI) force
 * the model to emit EVERY declared property, so a real call arrived as
 * `{sql: ". ", maxRows: 200, describe: true}` — both fields populated, `sql`
 * filled with junk — and the refinement rejected every single call.
 *
 * The fix is not a silent precedence rule ("describe wins"), which would guess
 * at intent. It is an explicit discriminator: the model STATES what it wants,
 * unused fields are ignored by contract, and nothing has to be inferred.
 *
 * Keep this union-free and refinement-free. Nested unions and cross-field
 * refinements do not survive provider schema conversion.
 */
export const QuerySelfInputSchema = z
  .object({
    analyze: z
      .boolean()
      .optional()
      .describe('mode=explain only: run the statement to get real timings (default false)'),
    lens: z.string().max(64).optional().describe('Lens id. Required for mode=lens'),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max rows for mode=query (default 50); truncation is flagged'),
    mode: z
      .enum(['query', 'listTables', 'describeTable', 'explain', 'listLenses', 'lens'])
      .describe(
        "What to do: 'listTables' lists tables, 'describeTable' lists one table's columns, 'query' runs sql, 'explain' returns sql's query plan, 'listLenses' lists saved lenses, 'lens' runs one by id"
      ),
    sql: z
      .string()
      .max(4000)
      .optional()
      // "read-only SELECT" is already stated twice in the tool description;
      // the scarce prompt budget buys the mode list instead.
      .describe('Required for mode=query and mode=explain'),
    table: z.string().max(128).optional().describe('Table name. Required for mode=describeTable'),
    target: z
      .enum(QUERY_SELF_TARGETS)
      .describe(
        'Database target: app for history and diagnostics; index for derived code/search data. Required in every mode'
      ),
    values: z
      .array(z.string().max(500))
      .max(8)
      .optional()
      .describe('mode=lens: one string per declared param, in order'),
  })
  .strict();

export type QuerySelfInput = z.infer<typeof QuerySelfInputSchema>;

// ============================================================================
// Query Diagnostics Tool Schema
// ============================================================================

export const QueryDiagnosticsInputSchema = z
  .object({
    fingerprint: z.string().min(1).max(256).optional().describe('Exact diagnostic fingerprint'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum events or groups to inspect (default 50, hard max 200)'),
    mode: z
      .enum(['events', 'fingerprints'])
      .describe('events returns newest rows; fingerprints groups recurring failures'),
    runId: z.string().min(1).max(256).optional().describe('Exact assistant run id'),
    severity: z.enum(['warn', 'error', 'fatal']).optional().describe('Exact severity'),
    since: z
      .string()
      .min(20)
      .max(35)
      .optional()
      .describe('Inclusive ISO-8601 lower bound, e.g. 2026-07-20T00:00:00Z'),
    threadId: z.string().min(1).max(256).optional().describe('Exact assistant thread id'),
    until: z
      .string()
      .min(20)
      .max(35)
      .optional()
      .describe('Inclusive ISO-8601 upper bound, e.g. 2026-07-28T00:00:00Z'),
  })
  .strict();

export type QueryDiagnosticsInput = z.infer<typeof QueryDiagnosticsInputSchema>;

// ============================================================================
// Queue Status Tool Schema
// ============================================================================

export const QueueStatusInputSchema = z
  .object({
    embeddingSetId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional: filter to specific embedding set'),
  })
  .strict();

export type QueueStatusInput = z.infer<typeof QueueStatusInputSchema>;

// ============================================================================
// Embedding Sets Tool Schemas
// ============================================================================

export const ListEmbeddingSetsInputSchema = z
  .object({
    includeStats: z.boolean().optional().describe('Include coverage statistics'),
    workspaceIndexOnly: z
      .boolean()
      .optional()
      .describe('Only return the embedding space configured as the current workspace index'),
  })
  .strict();

export type ListEmbeddingSetsInput = z.infer<typeof ListEmbeddingSetsInputSchema>;

export const CreateEmbeddingSetInputSchema = z
  .object({
    description: z.string().max(500).optional().describe('Optional description'),
    modelKey: z.string().min(1).describe('Model key (provider::model format)'),
    name: z.string().min(1).max(100).describe('Name for the embedding set'),
  })
  .strict();

export type CreateEmbeddingSetInput = z.infer<typeof CreateEmbeddingSetInputSchema>;

// ============================================================================
// System Diagnostics Tool Schema
// ============================================================================

export const SystemDiagnosticsInputSchema = z
  .object({
    categories: z
      .array(z.enum(['database', 'queue', 'worker', 'storage', 'all']))
      .optional()
      .describe('Diagnostic categories to check'),
  })
  .strict();

export type SystemDiagnosticsInput = z.infer<typeof SystemDiagnosticsInputSchema>;

// ============================================================================
// Re-embed Collection Tool Schema
// ============================================================================

export const ReembedCollectionInputSchema = z
  .object({
    embeddingSetId: z.string().min(1).describe('Embedding set ID to re-embed'),
    reason: z.string().max(200).optional().describe('Reason for re-embedding'),
  })
  .strict();
