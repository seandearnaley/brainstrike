/**
 * Panel-level composition of the file-row metadata seam (BST-1208).
 *
 * `useExplorerRowMetadata` is called at the ONE site that also mounts
 * `useBackgroundTokenIndexerIntegration` — the Explorer panel — because the
 * precise invalidation path only exists if `onTokenResolved` reaches the
 * indexer. Dropping that wiring is silent: every count arrival would degrade
 * into the 250ms bulk reconcile instead of repainting one cell. It is pinned by
 * `file-explorer-panel.test.tsx`.
 *
 * The context carries the store plus the per-root source registration, so a
 * tree can supply its own enumeration without the panel knowing how any root's
 * tree is shaped.
 *
 * The context is OPTIONAL by design: `OptimizedFileTree` also renders in
 * surfaces that never mount the seam (unit tests, and any future embedding
 * without a token cache). Capability gating — does the seam exist? — is the
 * repo's rule for this, and a tree without the seam simply renders the Name
 * column instead of inventing metadata.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createFileRowMetadataSourceRegistry,
  type FileRowMetadataSource,
} from './file-row-metadata-source-registry';
import type { FileRowMetadataStore } from './file-row-metadata-store';
import { useFileRowMetadataStore } from './use-file-row-metadata-store';

export interface FileRowMetadataContextValue {
  /**
   * Publish the composite keys of the files THIS root currently displays, so
   * the panel's background token indexer covers every mounted root instead of
   * only the focused one (whole-branch review F2). Empty set withdraws them.
   */
  publishVisibleFileKeys: (folderId: string, keys: ReadonlySet<string>) => void;
  /** Register this tree's per-root enumeration; returns an unregister fn. */
  registerSource: (folderId: string, source: FileRowMetadataSource) => () => void;
  store: FileRowMetadataStore;
}

const FileRowMetadataContext = createContext<FileRowMetadataContextValue | null>(null);

export function useOptionalFileRowMetadata(): FileRowMetadataContextValue | null {
  return useContext(FileRowMetadataContext);
}

/**
 * For metadata CELLS, which only exist because the column builder already
 * observed the seam. A missing provider there is a wiring bug, not a
 * capability difference, so it throws instead of rendering an empty column.
 */
export function useFileRowMetadata(): FileRowMetadataContextValue {
  const context = useContext(FileRowMetadataContext);
  if (!context) {
    throw new Error('useFileRowMetadata must be used within FileRowMetadataProvider');
  }
  return context;
}

export function FileRowMetadataProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: FileRowMetadataContextValue;
}) {
  return (
    <FileRowMetadataContext.Provider value={value}>{children}</FileRowMetadataContext.Provider>
  );
}

export interface ExplorerRowMetadata {
  contextValue: FileRowMetadataContextValue;
  /**
   * MUST be forwarded to `useBackgroundTokenIndexerIntegration`. See the module
   * comment: without it the tree grid silently falls back to bulk reconcile.
   */
  onTokenResolved: (compositeKey: string) => void;
  /**
   * Every mounted root's visible file keys, merged — the second (visible/
   * expanded) trigger for `useBackgroundTokenIndexerIntegration`. MUST be
   * forwarded as `visibleFiles`; the panel cannot derive this itself because in
   * forest mode each section owns its own display tree.
   */
  visibleFileKeys: ReadonlySet<string>;
}

export function useExplorerRowMetadata(): ExplorerRowMetadata {
  // Create-once (lazy useState) so the registry identity — and therefore the
  // store's source closures — never changes for the panel's lifetime.
  const [registry] = useState(createFileRowMetadataSourceRegistry);
  const sourceParams = useMemo(
    () => ({
      getDirectorySubtree: registry.getDirectorySubtree,
      getNodeSize: registry.getNodeSize,
    }),
    [registry]
  );
  const { onTokenResolved, store } = useFileRowMetadataStore(sourceParams);
  const contextValue = useMemo<FileRowMetadataContextValue>(
    () => ({
      publishVisibleFileKeys: registry.setVisibleFileKeys,
      registerSource: registry.register,
      store,
    }),
    [registry, store]
  );
  // The registry keeps the merged snapshot CONTENT-stable, which is what stops
  // an unchanged republication from re-arming the visible-indexing debounce.
  const visibleFileKeys = useSyncExternalStore(
    registry.subscribeVisibleFileKeys,
    registry.getVisibleFileKeys,
    registry.getVisibleFileKeys
  );
  return useMemo(
    () => ({ contextValue, onTokenResolved, visibleFileKeys }),
    [contextValue, onTokenResolved, visibleFileKeys]
  );
}
