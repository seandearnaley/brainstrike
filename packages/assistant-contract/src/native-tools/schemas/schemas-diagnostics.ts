/**
 * Input schemas for the diagnostics, queue and embedding-set agent tools.
 *
 * Authored in Effect Schema: ADR-0004 (amended 2026-10-15) makes Effect the
 * single boundary owner, and `effectToolInputSchema` derives the provider JSON
 * Schema from these declarations. Flat closed objects throughout — there is no
 * action union here, so an unknown key is a hallucinated parameter.
 */
import { Schema } from 'effect';

/**
 * A length-bounded string whose ADVERTISED bounds are the ones it enforces.
 *
 * `isMinCodePoints`, not `isMinLength`: the latter emits
 * `minLength: Math.ceil(n / 2)` and would advertise half the real minimum.
 * `isMaxLength`, not `isMaxCodePoints`: the latter would accept strings the
 * zod version rejected. See "String length bounds" in
 * `docs/agents/effect-schema-migration.md`.
 */
const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinCodePoints(minimum), Schema.isMaxLength(maximum));

/** A non-empty string with no upper bound. */
const nonEmpty = Schema.String.check(Schema.isMinCodePoints(1));

/** An ISO-8601 instant, bounded to the lengths the offset forms occupy. */
const isoBound = bounded(20, 35);

// ============================================================================
// Query Diagnostics Tool Schema
// ============================================================================

export const QueryDiagnosticsInputSchema = Schema.Struct({
  fingerprint: Schema.optionalKey(
    bounded(1, 256).annotate({ description: 'Exact diagnostic fingerprint' })
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)).annotate({
      description: 'Maximum events or groups to inspect (default 50, hard max 200)',
    })
  ),
  mode: Schema.Literals(['events', 'fingerprints']).annotate({
    description: 'events returns newest rows; fingerprints groups recurring failures',
  }),
  runId: Schema.optionalKey(bounded(1, 256).annotate({ description: 'Exact assistant run id' })),
  severity: Schema.optionalKey(
    Schema.Literals(['warn', 'error', 'fatal']).annotate({ description: 'Exact severity' })
  ),
  since: Schema.optionalKey(
    isoBound.annotate({
      description: 'Inclusive ISO-8601 lower bound, e.g. 2026-07-20T00:00:00Z',
    })
  ),
  threadId: Schema.optionalKey(
    bounded(1, 256).annotate({ description: 'Exact assistant thread id' })
  ),
  until: Schema.optionalKey(
    isoBound.annotate({
      description: 'Inclusive ISO-8601 upper bound, e.g. 2026-07-28T00:00:00Z',
    })
  ),
});

export type QueryDiagnosticsInput = typeof QueryDiagnosticsInputSchema.Type;

// ============================================================================
// Queue Status Tool Schema
// ============================================================================

export const QueueStatusInputSchema = Schema.Struct({
  embeddingSetId: Schema.optionalKey(
    nonEmpty.annotate({
      description: 'Optional: filter to specific embedding set',
    })
  ),
});

export type QueueStatusInput = typeof QueueStatusInputSchema.Type;

// ============================================================================
// Embedding Sets Tool Schemas
// ============================================================================

export const ListEmbeddingSetsInputSchema = Schema.Struct({
  includeStats: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Include coverage statistics' })
  ),
  workspaceIndexOnly: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'Only return the embedding space configured as the current workspace index',
    })
  ),
});

export type ListEmbeddingSetsInput = typeof ListEmbeddingSetsInputSchema.Type;

export const CreateEmbeddingSetInputSchema = Schema.Struct({
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(500)).annotate({ description: 'Optional description' })
  ),
  modelKey: nonEmpty.annotate({
    description: 'Model key (provider::model format)',
  }),
  name: bounded(1, 100).annotate({ description: 'Name for the embedding set' }),
});

export type CreateEmbeddingSetInput = typeof CreateEmbeddingSetInputSchema.Type;

// ============================================================================
// System Diagnostics Tool Schema
// ============================================================================

export const SystemDiagnosticsInputSchema = Schema.Struct({
  categories: Schema.optionalKey(
    Schema.Array(Schema.Literals(['database', 'queue', 'worker', 'storage', 'all'])).annotate({
      description: 'Diagnostic categories to check',
    })
  ),
});

export type SystemDiagnosticsInput = typeof SystemDiagnosticsInputSchema.Type;

// ============================================================================
// Re-embed Collection Tool Schema
// ============================================================================

export const ReembedCollectionInputSchema = Schema.Struct({
  embeddingSetId: nonEmpty.annotate({
    description: 'Embedding set ID to re-embed',
  }),
  reason: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: 'Reason for re-embedding',
    })
  ),
});
