import { z } from 'zod';

// ============================================================================
// Hybrid Search Tool Schema
// ============================================================================

export const HybridSearchInputSchema = z
  .object({
    query: z.string().min(1).max(2000).describe('Search query text'),
    embeddingSetId: z.string().min(1).describe('Embedding set ID for vector search'),
    limit: z.number().int().positive().max(100).optional().describe('Maximum results to return'),
    vectorWeight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Weight for vector search (default 1.0)'),
    ftsWeight: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Weight for full-text search (default 1.0)'),
    vectorThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity threshold'),
    filePaths: z
      .array(z.string().min(1))
      .max(1000)
      .optional()
      .describe('Filter to specific file paths'),
    chunkType: z
      .enum(['text', 'code', 'sentence', 'recursive'])
      .optional()
      .describe('Filter by chunk type'),
  })
  .strict();

export type HybridSearchInput = z.infer<typeof HybridSearchInputSchema>;

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
  })
  .strict();

export type ListEmbeddingSetsInput = z.infer<typeof ListEmbeddingSetsInputSchema>;

export const CreateEmbeddingSetInputSchema = z
  .object({
    name: z.string().min(1).max(100).describe('Name for the embedding set'),
    modelKey: z.string().min(1).describe('Model key (provider::model format)'),
    description: z.string().max(500).optional().describe('Optional description'),
  })
  .strict();

export type CreateEmbeddingSetInput = z.infer<typeof CreateEmbeddingSetInputSchema>;

// ============================================================================
// File Tree Tool Schema
// ============================================================================

export const QueryFileTreeInputSchema = z
  .object({
    path: z.string().optional().describe('Directory path to query (defaults to root)'),
    pattern: z.string().optional().describe('Glob pattern to filter files'),
    maxDepth: z.number().int().positive().max(10).optional().describe('Maximum depth to traverse'),
    includeHidden: z.boolean().optional().describe('Include hidden files/directories'),
  })
  .strict();

export type QueryFileTreeInput = z.infer<typeof QueryFileTreeInputSchema>;

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

export type ReembedCollectionInput = z.infer<typeof ReembedCollectionInputSchema>;

// ============================================================================
// Existing Schemas (Filesystem, Web, Retrieval)
// ============================================================================

const FilesystemListInput = z
  .object({
    path: z.string().min(1).optional(),
  })
  .strict();

export type FilesystemListInput = z.infer<typeof FilesystemListInput>;

const FilesystemReadInput = z
  .object({
    path: z.string().min(1),
    encoding: z.enum(['utf8', 'base64']).optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024)
      .optional(),
  })
  .strict();

export type FilesystemReadInput = z.infer<typeof FilesystemReadInput>;

const FilesystemSearchInput = z
  .object({
    query: z.string().min(1),
    path: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(5000).optional(),
    maxDepth: z.number().int().positive().max(10).optional(),
  })
  .strict();

export type FilesystemSearchInput = z.infer<typeof FilesystemSearchInput>;

const EchoInput = z.object({ text: z.string().min(1) }).strict();

const WebSearchDocsInput = z
  .object({
    query: z.string().min(2).max(200),
    limit: z.number().int().positive().max(10).optional(),
  })
  .strict();

export type WebSearchDocsInput = z.infer<typeof WebSearchDocsInput>;

const WebDocSummaryInput = z
  .object({
    docId: z.string().min(1).max(120),
  })
  .strict();

export type WebDocSummaryInput = z.infer<typeof WebDocSummaryInput>;

export const RetrievalContextInputSchema = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().positive().max(100).optional(),
    threshold: z.number().min(0).max(1).optional(),
    tokenBudget: z.number().int().positive().max(200_000).optional(),
    maxChunks: z.number().int().positive().max(100).optional(),
    embeddingSetId: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).max(5000).optional(),
    selectionSnapshotId: z.string().min(1).optional(),
  })
  .strict();

export type RetrievalContextInput = z.infer<typeof RetrievalContextInputSchema>;

const schemaMap: Record<string, z.ZodSchema> = {
  // Filesystem tools
  'filesystem.list': FilesystemListInput,
  'filesystem.read': FilesystemReadInput,
  'filesystem.search': FilesystemSearchInput,
  // Web tools
  'web.echo': EchoInput,
  'web.searchDocs': WebSearchDocsInput,
  'web.docSummary': WebDocSummaryInput,
  // BrainStrike native tools
  'brainstrike.retrieveContext': RetrievalContextInputSchema,
  'brainstrike.hybridSearch': HybridSearchInputSchema,
  'brainstrike.queueStatus': QueueStatusInputSchema,
  'brainstrike.listEmbeddingSets': ListEmbeddingSetsInputSchema,
  'brainstrike.createEmbeddingSet': CreateEmbeddingSetInputSchema,
  'brainstrike.queryFileTree': QueryFileTreeInputSchema,
  'brainstrike.systemDiagnostics': SystemDiagnosticsInputSchema,
  'brainstrike.reembedCollection': ReembedCollectionInputSchema,
};

function formatZodIssue(issue: z.ZodIssue): string {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  const prefix = path.length > 0 ? `${path} ` : '';
  return `${prefix}${issue.message}`;
}

function parseWithSchema(
  schema: z.ZodSchema,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    return {
      ok: false,
      issues: res.error.issues.map((issue) => formatZodIssue(issue)),
    };
  }
  return { ok: true, data: res.data };
}

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  try {
    const schema = schemaMap[name];
    if (schema) {
      return parseWithSchema(schema, params);
    }
    // Unknown tool: accept pass-through to let host handle or fail later
    return { ok: true, data: params ?? {} };
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}
