import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import {
  type NativeIndexSettings,
  nativeIndexSettingsFromConfig,
} from '@brainstrike/canonical-ingestion';
import { IndexConfigStoreFailed } from '../../index-config';

export const SPACE = 'space-1';
export const MODEL = {
  dimensions: 384,
  local: { device: 'wasm', dtype: 'q8' },
  modelKey: 'local::Xenova/bge-small-en-v1.5',
} as const;
export const textSettings = (change: Partial<IndexConfig> = {}) =>
  nativeIndexSettingsFromConfig({ ...DEFAULT_INDEX_CONFIG, ...change }, null);
/** `space` is the `workspace-index` vector space Main ensured for the model. */
export const vectorSettings = (change: Partial<IndexConfig> = {}, space: string = SPACE) =>
  nativeIndexSettingsFromConfig(
    { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL, ...change },
    space
  );
/**
 * The engine's rootless collection partition, scanned through the TEXT pipeline so no inference
 * runs. Main's config gives a collection only to semantic search; the activation tests drive the
 * engine's collection scan with this until that partition is deleted (plan follow-up).
 */
export const textCollectionSettings = (
  change: Partial<IndexConfig> = {},
  collection = 'selected'
): NativeIndexSettings => ({ ...textSettings(change), managedCollectionId: collection });
/** What Main's config owner rejects with when the saved config does not decode. */
export const unreadableSettings = () =>
  new IndexConfigStoreFailed({
    cause: new TypeError('The saved search index config does not decode.'),
    message: 'The search index settings could not be read.',
  });
