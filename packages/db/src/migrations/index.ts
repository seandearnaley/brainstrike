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
import { migration051PromptLibrary } from './051-prompt-library.js';
import { migration052AssistantEditCheckpoints } from './052-assistant-edit-checkpoints.js';
import { migration053Bm25ContentIndex } from './053-bm25-content-index.js';
import { migration054AssistantThreadGroups } from './054-assistant-thread-groups.js';
import { migration055AssistantMessageParents } from './055-assistant-message-parents.js';
import { migration056AssistantThreadGroupPresentation } from './056-assistant-thread-group-presentation.js';
import { migration057UpdateProviderModels202607 } from './057-update-provider-models-2026-07.js';
import { migration058ProviderBilledCost } from './058-provider-billed-cost.js';
import { migration059AssistantThreadGroupIcons } from './059-assistant-thread-group-icons.js';
import { migration060OpenRouterSparkKimiK3 } from './060-openrouter-spark-kimi-k3.js';
import { migration061ModelVisionCapability } from './061-model-vision-capability.js';
import { migration062AssistantRunOutcomes } from './062-assistant-run-outcomes.js';
import { migration063IndexConsolidation } from './063-index-consolidation.js';
import { migration064JobQueueOutcomeMetrics } from './064-job-queue-outcome-metrics.js';
import { migration065QuarantinePgTextsearch } from './065-quarantine-pg-textsearch.js';
import { migration066RestorePgTextsearch } from './066-restore-pg-textsearch.js';
import { migration067ThreadSearchIndex } from './067-thread-search-index.js';
import { migration068ToolOutputArtifacts } from './068-tool-output-artifacts.js';
import { migration069RunUsageCacheTokens } from './069-run-usage-cache-tokens.js';
import { migration070MinimaxM3Vision } from './070-minimax-m3-vision.js';
import { migration071OpenRouterJulyCodingModels } from './071-openrouter-july-coding-models.js';
import { migration072OpenRouterLing3Flash } from './072-openrouter-ling-3-flash.js';
import { migration073DiagnosticEvents } from './073-diagnostic-events.js';
import { migration074AgentReadonlyRole } from './074-agent-readonly-role.js';
import { migration075FileSymbols } from './075-file-symbols.js';
import { migration076AssistantRunErrors } from './076-assistant-run-errors.js';
import { migration077RunUsageKind } from './077-run-usage-kind.js';
import { migration078JobQueueDedupeActiveIndex } from './078-job-queue-dedupe-active-index.js';
import { migration079MindOpsLog } from './079-mind-ops-log.js';
import { migration080AssistantMessageTombstones } from './080-assistant-message-tombstones.js';
import { migration081WorkspaceSnapshots } from './081-workspace-snapshots.js';
import { migration082CanvasDocuments } from './082-canvas-documents.js';
import { migration083ToolCallTelemetry } from './083-tool-call-telemetry.js';
import { migration084AssistantToolProjectionRewrites } from './084-assistant-tool-projection-rewrites.js';
import { migration085ToolCallTelemetryOccurredAtIndex } from './085-tool-call-telemetry-occurred-at-index.js';
import { migration086TokenEstimateCalibration } from './086-token-estimate-calibration.js';
import { migration087ToolProjectionRewriteKinds } from './087-tool-projection-rewrite-kinds.js';
import { migration088AssistantCompactionRanges } from './088-assistant-compaction-ranges.js';
import { migration089TokenEstimateCalibrationResolvedBudgets } from './089-token-estimate-calibration-resolved-budgets.js';
import { migration090CompactionSummaryRunUsageKind } from './090-compaction-summary-run-usage-kind.js';
import { migration091TokenEstimateCalibrationPromptBaseline } from './091-token-estimate-calibration-prompt-baseline.js';
import { migration092ToolCallTelemetrySubstrateSplit } from './092-tool-call-telemetry-substrate-split.js';
import { migration093AssistantRunTreatments } from './093-assistant-run-treatments.js';
import { migration094OpenRouterGemini37Flash } from './094-openrouter-gemini-3-7-flash.js';
import { migration095AssistantThreadWorkspaces } from './095-assistant-thread-workspaces.js';
import { migration096OpenRouterQwen3827B } from './096-openrouter-qwen-3-8-27b.js';
import { migration097OpenRouterQwen38TwoPointFourT } from './097-openrouter-qwen-3-8-2-4t-a95b.js';
import { migration098OpenRouterQwen38Max } from './098-openrouter-qwen-3-8-max.js';
import { migration099OpenRouterNemotron35Lightning } from './099-openrouter-nemotron-3-5-lightning.js';
import { migration100OpenRouterGrok46 } from './100-openrouter-grok-4-6.js';
import { migration101AmazonBedrock } from './101-amazon-bedrock.js';
import { migration102AmazonNova2Lite } from './102-amazon-nova-2-lite.js';
import { migration103OpenAiCodex } from './103-openai-codex.js';
import { migration104GoogleGemini37Flash } from './104-google-gemini-3-7-flash.js';
import { migration105EmbeddingJobInputHash } from './105-embedding-job-input-hash.js';
import { migration106OpenRouterMuseSpark12 } from './106-openrouter-muse-spark-1-2.js';
import { migration107OpenRouterOxAlpha } from './107-openrouter-ox-alpha.js';
import { migration108OpenRouterGlm53 } from './108-openrouter-glm-5-3.js';
import { migration109Worktrees } from './109-worktrees.js';
import { migration110ForgePrCache } from './110-forge-pr-cache.js';
import { migration111RootsWorktreeKind } from './111-roots-worktree-kind.js';
import { migration112WorktreeSetupReason } from './112-worktree-setup-reason.js';
import { migration113OpenRouterQwen38Flash } from './113-openrouter-qwen-3-8-flash.js';
import { migration114McpTasks } from './114-mcp-tasks.js';
import { migration115McpTaskAuthority } from './115-mcp-task-authority.js';
import { migration116AnthropicClaudeOpus5 } from './116-anthropic-claude-opus-5.js';
import { migration117MastraMemorySchema } from './117-mastra-memory-schema.js';
import { migration118AssistantThreadRuns } from './118-assistant-thread-runs.js';
import { migration119OpenrouterCatalogModels } from './119-openrouter-catalog-models.js';
import { migration120OpenrouterCatalogModels } from './120-openrouter-catalog-models.js';
import { migration121RetireDelistedOpenRouterModels } from './121-retire-delisted-openrouter-models.js';
import { migration122AnthropicBedrockCatalogModels } from './122-anthropic-bedrock-catalog-models.js';
import { migration123OpenaiGpt6Astra } from './123-openai-gpt-6-astra.js';
import { migration124GoogleCatalogModels } from './124-google-catalog-models.js';
import { migration125BedrockAnthropicClaudeOpus5 } from './125-bedrock-anthropic-claude-opus-5.js';
import { migration126DelegatedConversations } from './126-delegated-conversations.js';
import { migration127DelegatedInvocations } from './127-delegated-invocations.js';
import { migration128DelegatedInvocationUsage } from './128-delegated-invocation-usage.js';
import { migration129ArtifactExecutionScope } from './129-artifact-execution-scope.js';
import { migration130OpenrouterDeepseekDeepseekV41Flash } from './130-openrouter-deepseek-deepseek-v4-1-flash.js';
import { migration131DelegatedToolDecisions } from './131-delegated-tool-decisions.js';
import { migration132DelegationBudgets } from './132-delegation-budgets.js';
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
  migration051PromptLibrary,
  migration052AssistantEditCheckpoints,
  migration053Bm25ContentIndex,
  migration054AssistantThreadGroups,
  migration055AssistantMessageParents,
  migration056AssistantThreadGroupPresentation,
  migration057UpdateProviderModels202607,
  migration058ProviderBilledCost,
  migration059AssistantThreadGroupIcons,
  migration060OpenRouterSparkKimiK3,
  migration061ModelVisionCapability,
  migration062AssistantRunOutcomes,
  migration063IndexConsolidation,
  migration064JobQueueOutcomeMetrics,
  migration065QuarantinePgTextsearch,
  migration066RestorePgTextsearch,
  migration067ThreadSearchIndex,
  migration068ToolOutputArtifacts,
  migration069RunUsageCacheTokens,
  migration070MinimaxM3Vision,
  migration071OpenRouterJulyCodingModels,
  migration072OpenRouterLing3Flash,
  migration073DiagnosticEvents,
  migration074AgentReadonlyRole,
  migration075FileSymbols,
  migration076AssistantRunErrors,
  migration077RunUsageKind,
  migration078JobQueueDedupeActiveIndex,
  migration079MindOpsLog,
  migration080AssistantMessageTombstones,
  migration081WorkspaceSnapshots,
  migration082CanvasDocuments,
  migration083ToolCallTelemetry,
  migration084AssistantToolProjectionRewrites,
  migration085ToolCallTelemetryOccurredAtIndex,
  migration086TokenEstimateCalibration,
  migration087ToolProjectionRewriteKinds,
  migration088AssistantCompactionRanges,
  migration089TokenEstimateCalibrationResolvedBudgets,
  migration090CompactionSummaryRunUsageKind,
  migration091TokenEstimateCalibrationPromptBaseline,
  migration092ToolCallTelemetrySubstrateSplit,
  migration093AssistantRunTreatments,
  migration094OpenRouterGemini37Flash,
  migration095AssistantThreadWorkspaces,
  migration096OpenRouterQwen3827B,
  migration097OpenRouterQwen38TwoPointFourT,
  migration098OpenRouterQwen38Max,
  migration099OpenRouterNemotron35Lightning,
  migration100OpenRouterGrok46,
  migration101AmazonBedrock,
  migration102AmazonNova2Lite,
  migration103OpenAiCodex,
  migration104GoogleGemini37Flash,
  migration105EmbeddingJobInputHash,
  migration106OpenRouterMuseSpark12,
  migration107OpenRouterOxAlpha,
  migration108OpenRouterGlm53,
  migration109Worktrees,
  migration110ForgePrCache,
  migration111RootsWorktreeKind,
  migration112WorktreeSetupReason,
  migration113OpenRouterQwen38Flash,
  migration114McpTasks,
  migration115McpTaskAuthority,
  migration116AnthropicClaudeOpus5,
  migration117MastraMemorySchema,
  migration118AssistantThreadRuns,
  migration119OpenrouterCatalogModels,
  migration120OpenrouterCatalogModels,
  migration121RetireDelistedOpenRouterModels,
  migration122AnthropicBedrockCatalogModels,
  migration123OpenaiGpt6Astra,
  migration124GoogleCatalogModels,
  migration125BedrockAnthropicClaudeOpus5,
  migration126DelegatedConversations,
  migration127DelegatedInvocations,
  migration128DelegatedInvocationUsage,
  migration129ArtifactExecutionScope,
  migration130OpenrouterDeepseekDeepseekV41Flash,
  migration131DelegatedToolDecisions,
  migration132DelegationBudgets,
];

// Export base migrations (without chunks table) for test environments
export const baseMigrations: Migration[] = [
  migration001InitialSchema,
  migration002AddVectorColumns,
  migration003AddIndexes,
];

// Public route for the dimension-index helpers (BST-990 root-API drift —
// the root index previously bypassed this barrel for them).
export {
  createDimensionIndex,
  dropDimensionIndex,
  estimateEmbeddedRowCount,
  hnswParams,
  resolveIndexBuildMaintenanceWorkMemMb,
  resumeDimensionIndexBuilds,
  suspendDimensionIndexBuilds,
  withIndexBuildMaintenanceWorkMem,
} from './dimension-index-helpers.js';
export type { Migration } from './migration-runner';
// Re-export types and runner
export { MigrationRunner } from './migration-runner.js';
