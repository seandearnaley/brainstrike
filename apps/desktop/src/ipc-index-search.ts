import {
  type IndexConfig,
  type IndexConfigPatch,
  IndexConfigPatchSchema,
} from '@brainstrike/assistant-contract/index-config';
import type {
  IndexChunkBoundsCapability,
  IndexRootRegistrationCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { indexSearchContract } from './ipc-domains/index-search.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
import { type ContractArgs, NoArgs, NonBlankString } from './platform/ipc-args';

const RootIds = Schema.Array(NonBlankString).check(
  Schema.isUnique({ expected: 'unique root IDs' })
);
const Limit = Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }));
const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const CoverageRequest = Schema.Struct({ rootIds: RootIds });
const EmbeddingProfile = Schema.Struct({
  dimensions: Schema.Int.check(Schema.isBetween({ maximum: 16_000, minimum: 1 })),
  distance: Schema.Literals(['cosine', 'l2', 'ip']),
  modelId: NonBlankString,
  provider: Schema.Literals(['openai', 'google', 'cohere', 'voyage']),
});

export const indexSearchArgs = {
  coverage: Schema.Tuple([CoverageRequest]),
  coverageBatch: Schema.Tuple([Schema.NonEmptyArray(CoverageRequest)]),
  fileChunks: Schema.Tuple([
    Schema.Struct({
      paths: Schema.Array(NonEmptyString).check(Schema.isBetweenLength(1, 100)),
      rootId: NonBlankString,
    }),
  ]),
  readConfig: NoArgs,
  rebuild: NoArgs,
  resetConfig: NoArgs,
  rootsRegistered: NoArgs,
  search: Schema.Tuple([
    Schema.Union([
      Schema.Struct({
        limit: Limit,
        mode: Schema.Literals(['bm25', 'trigram']),
        rootIds: RootIds,
        text: Schema.String,
      }),
      Schema.Struct({
        limit: Limit,
        mode: Schema.Literal('vector'),
        profile: EmbeddingProfile,
        rootIds: RootIds,
        vector: Schema.Array(Schema.Finite),
      }).check(
        Schema.makeFilter(({ profile, vector }) => vector.length === profile.dimensions, {
          expected: "exactly the profile's dimensions in vector values",
        })
      ),
    ]),
  ]),
  status: NoArgs,
  updateConfig: Schema.Tuple([IndexConfigPatchSchema]),
} satisfies ContractArgs<typeof indexSearchContract>;

/** Root composes the authoritative runtime and its complete-scan receipts. */
export function registerIndexSearchIpcHandlers(
  capability: IndexSearchCapability & IndexChunkBoundsCapability,
  registration: IndexRootRegistrationCapability,
  config: {
    read(): Promise<IndexConfig>;
    reset(): Promise<IndexConfig>;
    update(patch: IndexConfigPatch): Promise<IndexConfig>;
  }
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const failure = { category: 'native-index', code: 'native-index-failed' };
  registerDomain(registry, 'workspace', indexSearchContract, indexSearchArgs, {
    coverage: (request) => settleIpcResult(failure, () => capability.coverage(request)),
    coverageBatch: (requests) => settleIpcResult(failure, () => capability.coverageBatch(requests)),
    fileChunks: (request) => settleIpcResult(failure, () => capability.fileChunks(request)),
    readConfig: () => settleIpcResult(failure, () => config.read()),
    rebuild: () => settleIpcResult(failure, () => capability.rebuild()),
    resetConfig: () => settleIpcResult(failure, () => config.reset()),
    rootsRegistered: () => settleIpcResult(failure, () => registration.rootsRegistered()),
    search: (request) => settleIpcResult(failure, () => capability.search(request)),
    status: () => settleIpcResult(failure, () => capability.status()),
    updateConfig: (patch) => settleIpcResult(failure, () => config.update(patch)),
  });
  return () => registry.unregisterAll();
}
