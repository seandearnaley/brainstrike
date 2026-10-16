// A scan's source inventory over the canonical catalog: desktop's native index and the browser's index worker
// (BST-1940) read a scope's authorized files through the same owner.
import type { VectorProfile } from '@brainstrike/indexer/browser';
import type {
  createNativeCanonicalCatalog,
  NativeCanonicalCatalogRecord,
} from './canonical-catalog.js';
import type { CanonicalCatalogFile, CanonicalFileIdentity, CanonicalSourceScope } from './ports.js';
import type { createNativeScanAdmission } from './scan-admission.js';
import type { CanonicalSourceInventoryPort } from './workspace-source-ports.js';

export function createNativeSourceInventory(dependencies: {
  readonly assertSource: () => void;
  readonly catalog: ReturnType<typeof createNativeCanonicalCatalog<VectorProfile>>;
  readonly identity: (record: NativeCanonicalCatalogRecord) => CanonicalFileIdentity;
  readonly loadRecords: () => Promise<readonly NativeCanonicalCatalogRecord[]>;
  readonly retainCollection: (records: readonly NativeCanonicalCatalogRecord[]) => void;
  readonly scanAdmission: ReturnType<typeof createNativeScanAdmission>;
  readonly scope: CanonicalSourceScope;
}): CanonicalSourceInventoryPort {
  const { catalog, scanAdmission, scope } = dependencies;
  return {
    loadFiles: async (requested, context) => {
      if (
        scope.kind !== requested.kind ||
        (scope.kind === 'workspace' &&
          requested.kind === 'workspace' &&
          scope.rootId !== requested.rootId) ||
        (scope.kind === 'collection' &&
          requested.kind === 'collection' &&
          scope.embeddingSetId !== requested.embeddingSetId)
      ) {
        throw new Error('Canonical source inventory scope changed.');
      }
      await scanAdmission.waitForCollection(context);
      const records = (scanAdmission.getInventory() ?? (await dependencies.loadRecords())).filter(
        (record) => requested.kind === 'collection' || record.rootId === requested.rootId
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
      if (scope.kind === 'collection') {
        dependencies.retainCollection(records);
      }
      return files;
    },
    readRetained: (file, maxBytes, context) =>
      catalog.readRetainedSource(file, maxBytes, scope, context),
  };
}
