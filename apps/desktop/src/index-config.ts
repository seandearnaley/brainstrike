import { randomUUID } from 'node:crypto';
import type { IndexConfigPort } from '@brainstrike/agent-host/catalog';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
  IndexConfigPatchSchema,
  IndexConfigSchema,
  type IndexModel,
  indexModelId,
  sameIndexChunking,
} from '@brainstrike/assistant-contract/index-config';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import {
  type NativeIndexSettings,
  nativeIndexSettingsFromConfig,
} from '@brainstrike/canonical-ingestion';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import type { CollectionPort, CollectionRecord } from '@brainstrike/state-store';
import { DateTime, Effect, Schema } from 'effect';
import { traceNativeIndexWorkflow } from './native-index-effect-diagnostics';

/** A change the config cannot hold; nothing was saved. */
export class IndexConfigRefused extends Schema.TaggedError<IndexConfigRefused>()(
  'IndexConfigRefused',
  { message: Schema.String }
) {}
/** The host could not read or save the profile's config. */
export class IndexConfigStoreFailed extends Schema.TaggedError<IndexConfigStoreFailed>()(
  'IndexConfigStoreFailed',
  { cause: Schema.Defect(), message: Schema.String }
) {}
/** The config is saved, but the index has not applied it. */
export class IndexConfigApplyFailed extends Schema.TaggedError<IndexConfigApplyFailed>()(
  'IndexConfigApplyFailed',
  { cause: Schema.Defect(), message: Schema.String }
) {}

export interface DesktopIndexConfigDependencies {
  /** A registered provider's embedding model, as collection creation required. */
  readonly assertModel: (model: IndexModel) => void;
  readonly catalog: IndexConfigPort & CollectionPort;
  readonly publish: (config: IndexConfig) => void;
  readonly rebuild: () => Promise<void>;
  readonly reconfigure: () => Promise<void>;
  /** Retires the old vector space through the native owner; its resume ensures the new one. */
  readonly replaceVectorSpace: (id: string) => Promise<void>;
}

const PARSE = { errors: 'all', onExcessProperty: 'error' } as const;
const decodePatch = Schema.decodeUnknownEffect(IndexConfigPatchSchema, PARSE);
const decodeConfig = Schema.decodeUnknownEffect(IndexConfigSchema, PARSE);
const refused = (error: { readonly message: string }) =>
  new IndexConfigRefused({ message: error.message });
const sameModel = (space: CollectionRecord, model: IndexModel): boolean =>
  space.modelKey === model.modelKey && space.dimensions === model.dimensions;

/** A registered provider's embedding model; runtime-discovered local models verify at inference. */
export function assertRegisteredEmbeddingModel(model: IndexModel): void {
  const providerId = model.modelKey.slice(0, model.modelKey.indexOf('::'));
  const provider = findProviderDefinition(providerId);
  if (!provider) {
    throw new Error(`Search index model provider "${providerId}" is not registered.`);
  }
  const definition = provider.models.find((candidate) => candidate.id === indexModelId(model));
  if (
    !(provider.runtime === 'local' && provider.authType === 'none') &&
    definition?.type !== 'embedding'
  ) {
    throw new Error('Search index model must be a registered embedding model.');
  }
}

/** Main's owner of the profile's search index config: the one caller of `host/index-config`. */
export function createDesktopIndexConfig(dependencies: DesktopIndexConfigDependencies) {
  const store = <A>(message: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      catch: (cause) => new IndexConfigStoreFailed({ cause, message }),
      try: run,
    });
  const apply = (message: string, run: () => Promise<void>) =>
    Effect.tryPromise({
      catch: (cause) => new IndexConfigApplyFailed({ cause, message }),
      try: run,
    });

  const read = Effect.fn('IndexConfig.read')(function* () {
    const { config } = yield* store('The search index settings could not be read.', () =>
      dependencies.catalog.indexConfig({ operation: 'read' })
    );
    return config ?? DEFAULT_INDEX_CONFIG;
  });

  const vectorSpace = Effect.fn('IndexConfig.vectorSpace')(function* () {
    const { collections } = yield* store('The search index vector space could not be read.', () =>
      dependencies.catalog.collections({ operation: 'list' })
    );
    return collections.find((row) => row.systemRole === 'workspace-index') ?? null;
  });

  const update = Effect.fn('IndexConfig.update')(function* (patch: unknown) {
    const change = yield* decodePatch(patch).pipe(Effect.mapError(refused));
    const previous = yield* read();
    const next = yield* decodeConfig({
      ...previous,
      ...change,
      worktrees: { ...previous.worktrees, ...change.worktrees },
    }).pipe(Effect.mapError(refused));
    const model = next.model;
    if (model !== null) {
      yield* Effect.try({
        catch: (cause) =>
          new IndexConfigRefused({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        try: () => dependencies.assertModel(model),
      });
    }
    yield* store('The search index settings could not be saved.', () =>
      dependencies.catalog.indexConfig({ config: next, operation: 'write' })
    );
    dependencies.publish(next);
    const space = yield* vectorSpace();
    if (next.mode === 'semantic' && model !== null && space !== null && !sameModel(space, model)) {
      yield* apply("The previous model's vectors could not be removed.", () =>
        dependencies.replaceVectorSpace(space.id)
      );
    } else if (sameIndexChunking(previous.chunking, next.chunking)) {
      yield* apply('The search index could not apply the new settings.', dependencies.reconfigure);
    } else {
      yield* apply(
        'The search index could not rebuild with the new chunking.',
        dependencies.rebuild
      );
    }
    return next;
  });

  const nativeSettings = Effect.fn('IndexConfig.nativeSettings')(function* () {
    const config = yield* read();
    const model = config.mode === 'semantic' ? config.model : null;
    if (model === null) {
      return nativeIndexSettingsFromConfig(config, null);
    }
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const { collections } = yield* store(
      'The search index vector space could not be created.',
      () =>
        dependencies.catalog.collections({
          collection: {
            createdAt,
            dimensions: model.dimensions,
            distance: 'cosine',
            id: randomUUID(),
            modelId: indexModelId(model),
            modelKey: model.modelKey,
            name: 'Search index',
            systemRole: 'workspace-index',
          },
          operation: 'create',
        })
    );
    const space = collections[0];
    if (space === undefined || !sameModel(space, model)) {
      return yield* new IndexConfigApplyFailed({
        cause: null,
        message:
          "The search index still holds the previous model's vectors. Apply the model again in Settings, Search & Indexing.",
      });
    }
    return nativeIndexSettingsFromConfig(config, space.id);
  });

  return {
    nativeSettings: (): Promise<NativeIndexSettings> =>
      runAtPromiseBoundary(
        traceNativeIndexWorkflow(nativeSettings(), 'index-config.native-settings')
      ),
    read: (): Promise<IndexConfig> =>
      runAtPromiseBoundary(traceNativeIndexWorkflow(read(), 'index-config.read')),
    update: (patch: unknown): Promise<IndexConfig> =>
      runAtPromiseBoundary(traceNativeIndexWorkflow(update(patch), 'index-config.update')),
  };
}
