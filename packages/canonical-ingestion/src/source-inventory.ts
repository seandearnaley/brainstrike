// A scan's source inventory over the canonical catalog: desktop's native index reads a scope's authorized files
// through this owner.
import type { VectorProfile } from '@brainstrike/indexer';
import type {
  createNativeCanonicalCatalog,
  NativeCanonicalCatalogRecord,
} from './canonical-catalog.js';
import type { CanonicalCatalogFile, CanonicalFileIdentity, CanonicalSourceScope } from './ports.js';
import type { CanonicalSourceInventoryPort } from './workspace-source-ports.js';

export function createNativeSourceInventory(dependencies: {
  readonly assertSource: () => void;
  readonly catalog: ReturnType<typeof createNativeCanonicalCatalog<VectorProfile>>;
  readonly identity: (record: NativeCanonicalCatalogRecord) => CanonicalFileIdentity;
  readonly loadRecords: () => Promise<readonly NativeCanonicalCatalogRecord[]>;
  readonly scope: CanonicalSourceScope;
}): CanonicalSourceInventoryPort {
  const { catalog, scope } = dependencies;
  return {
    loadFiles: async (requested, context) => {
      if (scope.rootId !== requested.rootId) {
        throw new Error('Canonical source inventory scope changed.');
      }
      const records = (await dependencies.loadRecords()).filter(
        (record) => record.rootId === requested.rootId
      );
      const files: CanonicalCatalogFile[] = [];
      for (let offset = 0; offset < records.length; offset += 250) {
        context.signal.throwIfAborted();
        dependencies.assertSource();
        files.push(
          ...(await catalog.loadAuthorizedBatch(
            {
              files: records.slice(offset, offset + 250).map(dependencies.identity),
              scope,
            },
            context
          ))
        );
        context.signal.throwIfAborted();
        dependencies.assertSource();
      }
      return files;
    },
  };
}
