import { z } from 'zod';

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
