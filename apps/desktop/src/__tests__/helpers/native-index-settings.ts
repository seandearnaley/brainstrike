import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import { nativeIndexSettingsFromConfig } from '@brainstrike/canonical-ingestion';
import { IndexConfigStoreFailed } from '../../index-config';

const SPACE = 'space-1';
const MODEL = { dimensions: 1536, modelKey: 'openai::text-embedding-3-small' } as const;
export const textSettings = (change: Partial<IndexConfig> = {}) =>
  nativeIndexSettingsFromConfig({ ...DEFAULT_INDEX_CONFIG, ...change }, null);
/** `space` is the `workspace-index` vector space Main ensured for the model. */
export const vectorSettings = (change: Partial<IndexConfig> = {}, space: string = SPACE) =>
  nativeIndexSettingsFromConfig(
    { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL, ...change },
    space
  );
/** What Main's config owner rejects with when the saved config does not decode. */
export const unreadableSettings = () =>
  new IndexConfigStoreFailed({
    cause: new TypeError('The saved search index config does not decode.'),
    message: 'The search index settings could not be read.',
  });
