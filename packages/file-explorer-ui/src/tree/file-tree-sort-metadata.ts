import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';
import type { FileRowMetadataStore } from '../indexing/file-row-metadata-store';
import type { FileTreeSortMetadata } from './optimized-file-tree-model';

/**
 * Build the production metadata reader used by Explorer sorting.
 *
 * Keeping this seam outside the component lets the 10k-row performance test
 * exercise the exact production reader instead of maintaining a copied
 * closure that can drift. File reads deliberately use `peekSnapshot`: sorting
 * sweeps the whole projection, so populating the subscription cache here would
 * defeat its viewport bound.
 */
export function createFileTreeSortMetadataReader(
  folderId: string,
  store: FileRowMetadataStore
): (node: IFileNode) => FileTreeSortMetadata {
  if (folderId === '') {
    throw new Error('Explorer metadata sort requires a ready workspace root id');
  }

  return (node: IFileNode): FileTreeSortMetadata => {
    const compositeKey = encodeFileSelection(folderId, node.path);
    if (node.type === 'directory') {
      const rollup = store.getDirectorySnapshot(compositeKey);
      return {
        size: rollup.status === 'complete' ? rollup.size : 'pending',
        tokens: rollup.status === 'complete' ? rollup.tokens : 'pending',
        type: '',
      };
    }

    const metadata = store.peekSnapshot(compositeKey);
    return {
      size: metadata.size ?? 'pending',
      tokens: metadata.tokens,
      type: metadata.type,
    };
  };
}
