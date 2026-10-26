import type { IndexChunking, IndexConfig } from '@brainstrike/assistant-contract/index-config';
import type { NativeIndexMode } from '@brainstrike/indexing-contract/indexer-producer';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';

/** What Main's native index runs, derived from the profile's saved index config. */
export interface NativeIndexSettings {
  readonly chunking: IndexChunking;
  readonly enabled: boolean;
  readonly indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  /** The `workspace-index` vector space under semantic search; text search uses none (BST-1988). */
  readonly managedCollectionId: string | null;
  readonly mode: NativeIndexMode;
  readonly paused: boolean;
  readonly worktreeOptIns: ReadonlySet<string>;
}

/** `vectorSpaceId` is the `workspace-index` row Main ensured for this config's model. */
export function nativeIndexSettingsFromConfig(
  config: IndexConfig,
  vectorSpaceId: string | null
): NativeIndexSettings {
  const model = config.mode === 'semantic' ? config.model : null;
  if (model !== null && vectorSpaceId === null) {
    throw new Error('Semantic search has no vector space for its model.');
  }
  return {
    chunking: config.chunking,
    enabled: config.mode !== 'off',
    indexingPolicyPreset: config.policy,
    managedCollectionId: model === null ? null : vectorSpaceId,
    mode: model === null ? 'TEXT' : 'VECTOR',
    paused: config.paused,
    worktreeOptIns: new Set(
      Object.entries(config.worktrees).flatMap(([rootId, indexed]) => (indexed ? [rootId] : []))
    ),
  };
}

/** Pause changes source admission only; every other choice defines the retained authority. */
export function nativeIndexConfigurationIdentity(settings: NativeIndexSettings): string {
  return JSON.stringify([
    settings.chunking,
    settings.enabled,
    settings.indexingPolicyPreset,
    settings.managedCollectionId,
    settings.mode,
    [...settings.worktreeOptIns].sort(),
  ]);
}
