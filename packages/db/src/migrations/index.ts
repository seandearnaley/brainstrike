// Import all migrations
import { migration001InitialSchema } from './001-initial-schema.js';
import { migration002AddVectorColumns } from './002-add-vector-columns.js';
import { migration003AddIndexes } from './003-add-indexes.js';
import { migration004AddChunksTable } from './004-add-chunks-table.js';
import { migration005SafeIndices } from './005-safe-indices.js';
import { migration006EmbeddingSetsAndColumns } from './006-embedding-sets-and-columns.js';
import { migration007JobQueue } from './007-job-queue.js';
import { migration008JobQueueClaimIndex } from './008-job-queue-claim-index.js';
import { migration009VectorIndexTuning } from './009-vector-index-tuning.js';
import { migration010FlexibleEmbeddingDimensions } from './010-flexible-embedding-dimensions.js';
import { migration011EmbeddingSetMetadata } from './011-embedding-set-metadata.js';
import { migration012FileRecordsEmbeddingSet } from './012-file-records-embedding-set.js';
import { migration013EmbeddingSetsAllowDuplicates } from './013-embedding-sets-allow-duplicates.js';
import { migration014DimensionHnswIndexes } from './014-dimension-hnsw-indexes.js';
import { migration015ModelRegistry } from './015-model-registry.js';
import { migration016TokenCache } from './016-token-cache.js';
import { migration017AddAllowDuplicatesColumn } from './017-add-allow-duplicates-column.js';
import { migration018SelectionSnapshots } from './018-selection-snapshots.js';
import { migration019FtsTsvectorColumn } from './019-fts-tsvector-column.js';
import { migration020LocalLlmModels } from './020-local-llm-models.js';
import { migration021RenameTransformersToLocal } from './021-rename-transformers-to-local.js';
import { migration022EnableDefaultEmbeddingModels } from './022-enable-default-embedding-models.js';
import { migration023FixLocalProviderEnabled } from './023-fix-local-provider-enabled.js';
import { migration024FixLlmToolCalling } from './024-fix-llm-tool-calling.js';
import { migration025UpdateProviderModels2026 } from './025-update-provider-models-2026.js';
import { migration026UpdateProviderModels2026V2 } from './026-update-provider-models-2026-v2.js';
import { migration027ViewFilterPresets } from './027-view-filter-presets.js';
import { migration028GemmaLocalLlm } from './028-gemma-local-llm.js';
import { migration029FileRecordSourceRootPath } from './029-file-record-source-root-path.js';
import { migration030CollectionIndexingStats } from './030-collection-indexing-stats.js';
import { migration031ProviderCatalogTimestamps } from './031-provider-catalog-timestamps.js';
import { migration032FileChunkSourceRanges } from './032-file-chunk-source-ranges.js';
import { migration033UpdateProviderModels2026Frontier } from './033-update-provider-models-2026-frontier.js';
import { migration034TsvectorGeneratedColumn } from './034-tsvector-generated-column.js';
import { migration035Uuidv7PrimaryKeys } from './035-uuidv7-primary-keys.js';
import { migration036WorkspaceIndexSystemRole } from './036-workspace-index-system-role.js';
import { migration037FileRecordMtimeMs } from './037-file-record-mtime-ms.js';
import { migration038PgTrgmGrepIndex } from './038-pg-trgm-grep-index.js';
import { migration039RootsTable } from './039-roots-table.js';
import { migration040RetireSourceRootPath } from './040-retire-source-root-path.js';
import { migration041RootsPathIdentity } from './041-roots-path-identity.js';
import { migration042JobQueueChunkId } from './042-job-queue-chunk-id.js';
import { migration043JobQueueEmbeddingSetId } from './043-job-queue-embedding-set-id.js';
import { migration044DimensionIndexSuspensions } from './044-dimension-index-suspensions.js';
import { migration045DimensionIndexMaintenance } from './045-dimension-index-maintenance.js';
import { migration046AssistantRunUsage } from './046-assistant-run-usage.js';
import { migration047RunUsageRootId } from './047-run-usage-root-id.js';
import { migration048FileRecordsNameTrgm } from './048-file-records-name-trgm.js';
import { migration049JobQueueMetrics } from './049-job-queue-metrics.js';
import { migration050AssistantTaskLists } from './050-assistant-task-lists.js';
import { migration051AssistantEditCheckpoints } from './051-assistant-edit-checkpoints.js';
import type { Migration } from './migration-runner';

// Export all migrations in order
// Migration 004 is conditionally included based on pgvector availability
export const migrations: Migration[] = [
  migration001InitialSchema,
  migration002AddVectorColumns,
  migration003AddIndexes,
  migration004AddChunksTable,
  migration005SafeIndices,
  migration006EmbeddingSetsAndColumns,
  migration007JobQueue,
  migration008JobQueueClaimIndex,
  migration009VectorIndexTuning,
  migration010FlexibleEmbeddingDimensions,
  migration011EmbeddingSetMetadata,
  migration012FileRecordsEmbeddingSet,
  migration013EmbeddingSetsAllowDuplicates,
  migration014DimensionHnswIndexes,
  migration015ModelRegistry,
  migration016TokenCache,
  migration017AddAllowDuplicatesColumn,
  migration018SelectionSnapshots,
  migration019FtsTsvectorColumn,
  migration020LocalLlmModels,
  migration021RenameTransformersToLocal,
  migration022EnableDefaultEmbeddingModels,
  migration023FixLocalProviderEnabled,
  migration024FixLlmToolCalling,
  migration025UpdateProviderModels2026,
  migration026UpdateProviderModels2026V2,
  migration027ViewFilterPresets,
  migration028GemmaLocalLlm,
  migration029FileRecordSourceRootPath,
  migration030CollectionIndexingStats,
  migration031ProviderCatalogTimestamps,
  migration032FileChunkSourceRanges,
  migration033UpdateProviderModels2026Frontier,
  migration034TsvectorGeneratedColumn,
  migration035Uuidv7PrimaryKeys,
  migration036WorkspaceIndexSystemRole,
  migration037FileRecordMtimeMs,
  migration038PgTrgmGrepIndex,
  migration039RootsTable,
  migration040RetireSourceRootPath,
  migration041RootsPathIdentity,
  migration042JobQueueChunkId,
  migration043JobQueueEmbeddingSetId,
  migration044DimensionIndexSuspensions,
  migration045DimensionIndexMaintenance,
  migration046AssistantRunUsage,
  migration047RunUsageRootId,
  migration048FileRecordsNameTrgm,
  migration049JobQueueMetrics,
  migration050AssistantTaskLists,
  migration051AssistantEditCheckpoints,
];

// Export base migrations (without chunks table) for test environments
export const baseMigrations: Migration[] = [
  migration001InitialSchema,
  migration002AddVectorColumns,
  migration003AddIndexes,
];

export type { Migration } from './migration-runner';
// Re-export types and runner
export { MigrationRunner } from './migration-runner.js';
