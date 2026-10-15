/**
 * Metadata cells for the Explorer tree grid — Type, Tokens, Size (BST-1208).
 *
 * Each value cell subscribes to its OWN composite key on the BST-1207 metadata
 * store through `useSyncExternalStore`. That is the whole performance contract
 * of this layer: a token count landing for one file repaints that file's cell
 * and its enumerated ancestor directories, and nothing else — no row rebuild,
 * no tree-wide notify. The store returns identity-stable snapshots while a
 * value is unchanged, which is what makes the subscription cheap.
 *
 * NO SILENT FALLBACKS. Every non-value has its own explicit rendering:
 *
 * - `pending` — a quiet placeholder bar, never `0` and never `—`. "We have not
 *   counted this yet" is a different statement from "there is nothing here".
 * - `excluded` — an em dash with the binary-exclusion tooltip. The indexer will
 *   never count it, so a placeholder that implies "soon" would be a lie.
 * - a PARTIAL directory rollup — the same placeholder bar as `pending`, with a
 *   tooltip naming which of the two reasons applies. A partial sum is never
 *   rendered as a number, because a half-counted total is indistinguishable
 *   from a real one.
 *
 * The Type cell deliberately does NOT subscribe: an extension is a pure
 * function of the path and can never change under a row.
 */

import { getFileExtension } from '@brainstrike/utils/file-utils';
import { memo, useCallback, useSyncExternalStore } from 'react';
import { ExtensionBadge } from '../extension-badge';
import { useFileRowMetadata } from '../indexing/file-row-metadata-context';
import type {
  FileRowDirectoryRollup,
  FileRowMetadata,
  FileRowMetadataStore,
} from '../indexing/file-row-metadata-store';
import { formatTokenCount } from '../preview/use-preview-panel-state';
import { EXTENSIONLESS_FILE_TYPE } from '../utils/grouping-configs';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import type { FileTreeRowData } from './optimized-file-tree-model';
import { useRowCompositeKey } from './use-row-composite-key';

export const EXCLUDED_TOKENS_TITLE = 'binary file excluded from token counts';

const PARTIAL_ROLLUP_TITLE: Record<
  'incomplete-subtree' | 'pending-metadata' | 'recomputing',
  string
> = {
  'incomplete-subtree': 'Folder total unavailable — this folder is not fully enumerated',
  'pending-metadata': 'Folder total unavailable — some files are still being counted',
  recomputing: 'Folder total recomputing — this folder is still being enumerated',
};

interface MetadataCellProps {
  rowData: FileTreeRowData;
}

/**
 * Quiet "not known yet" mark. A bar rather than a glyph so it never reads as a
 * value, and low-contrast so a screen of uncounted rows stays calm.
 */
function PendingValue({ title }: { title: string }) {
  return (
    <span className="inline-flex items-center" title={title}>
      <span aria-hidden="true" className="h-1.5 w-5 rounded-full bg-foreground/15" />
      <span className="sr-only">{title}</span>
    </span>
  );
}

function UnavailableValue({ title }: { title: string }) {
  return (
    <span className="text-muted-foreground text-xs" title={title}>
      —<span className="sr-only">{` ${title}`}</span>
    </span>
  );
}

function NumericValue({ children, title }: { children: string; title: string }) {
  return (
    <span className="whitespace-nowrap font-mono text-xs tabular-nums" title={title}>
      {children}
    </span>
  );
}

/**
 * A row whose identity cannot be built. This is an invariant violation, not a
 * value that is on its way: no amount of indexing will ever fill this cell, so
 * it must NOT render the pending placeholder. It renders the unavailable dash
 * with an error tooltip, and the cause is logged once per row.
 */
const UNIDENTIFIED_ROW_TITLE = 'Metadata unavailable — this row has no workspace identity';

function useFileSnapshot(store: FileRowMetadataStore, compositeKey: string): FileRowMetadata {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(compositeKey, listener),
    [compositeKey, store]
  );
  const getSnapshot = useCallback(() => store.getSnapshot(compositeKey), [compositeKey, store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function useDirectoryRollup(
  store: FileRowMetadataStore,
  compositeKey: string
): FileRowDirectoryRollup {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(compositeKey, listener),
    [compositeKey, store]
  );
  const getSnapshot = useCallback(
    () => store.getDirectorySnapshot(compositeKey),
    [compositeKey, store]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Type — derived from the path, so no subscription and no directory value. */
export const FileTreeTypeCell = memo(function FileTreeTypeCellComponent({
  rowData,
}: MetadataCellProps) {
  const { name, type } = rowData.fileNode;
  if (type !== 'file') {
    return null;
  }
  const extension = getFileExtension(name) || EXTENSIONLESS_FILE_TYPE;
  return <ExtensionBadge extension={extension} size="compact" />;
});

function FileTokensValue({ compositeKey }: { compositeKey: string }) {
  const { store } = useFileRowMetadata();
  const metadata = useFileSnapshot(store, compositeKey);
  if (metadata.tokens === 'excluded') {
    return <UnavailableValue title={EXCLUDED_TOKENS_TITLE} />;
  }
  if (metadata.tokens === 'pending') {
    return <PendingValue title="Token count pending" />;
  }
  return (
    <NumericValue title={`${metadata.tokens.toLocaleString()} tokens`}>
      {formatTokenCount(metadata.tokens)}
    </NumericValue>
  );
}

function DirectoryTokensValue({ compositeKey }: { compositeKey: string }) {
  const { store } = useFileRowMetadata();
  const rollup = useDirectoryRollup(store, compositeKey);
  if (rollup.status === 'partial') {
    return <PendingValue title={PARTIAL_ROLLUP_TITLE[rollup.reason]} />;
  }
  return (
    <NumericValue title={`Folder total: ${rollup.tokens.toLocaleString()} tokens`}>
      {formatTokenCount(rollup.tokens)}
    </NumericValue>
  );
}

export const FileTreeTokensCell = memo(function FileTreeTokensCellComponent({
  rowData,
}: MetadataCellProps) {
  const compositeKey = useRowCompositeKey(rowData);
  if (!compositeKey) {
    return <UnavailableValue title={UNIDENTIFIED_ROW_TITLE} />;
  }
  if (rowData.fileNode.type === 'directory') {
    return <DirectoryTokensValue compositeKey={compositeKey} />;
  }
  if (rowData.fileNode.type !== 'file') {
    return null;
  }
  return <FileTokensValue compositeKey={compositeKey} />;
});

function FileSizeValue({ compositeKey }: { compositeKey: string }) {
  const { store } = useFileRowMetadata();
  const metadata = useFileSnapshot(store, compositeKey);
  if (metadata.size === undefined) {
    return <UnavailableValue title="Size unavailable" />;
  }
  return (
    <NumericValue title={`${metadata.size.toLocaleString()} bytes`}>
      {formatPreviewFileSize(metadata.size)}
    </NumericValue>
  );
}

function DirectorySizeValue({ compositeKey }: { compositeKey: string }) {
  const { store } = useFileRowMetadata();
  const rollup = useDirectoryRollup(store, compositeKey);
  if (rollup.status === 'partial') {
    return <PendingValue title={PARTIAL_ROLLUP_TITLE[rollup.reason]} />;
  }
  return (
    <NumericValue title={`Folder total: ${rollup.size.toLocaleString()} bytes`}>
      {formatPreviewFileSize(rollup.size)}
    </NumericValue>
  );
}

export const FileTreeSizeCell = memo(function FileTreeSizeCellComponent({
  rowData,
}: MetadataCellProps) {
  const compositeKey = useRowCompositeKey(rowData);
  if (!compositeKey) {
    return <UnavailableValue title={UNIDENTIFIED_ROW_TITLE} />;
  }
  if (rowData.fileNode.type === 'directory') {
    return <DirectorySizeValue compositeKey={compositeKey} />;
  }
  if (rowData.fileNode.type !== 'file') {
    return null;
  }
  return <FileSizeValue compositeKey={compositeKey} />;
});
