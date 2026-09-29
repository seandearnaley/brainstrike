import { createContext, useContext } from 'react';

/**
 * Live per-row state the catalog cells read. It lives in context, not in the
 * column closures, so the column definitions stay module-level constants and a
 * busy/download/query change never rebuilds the columns (TreeGrid row-identity
 * contract).
 */
export interface CatalogRowActions {
  readonly busyModelIds: ReadonlySet<string>;
  readonly downloadedModels: Readonly<Record<string, boolean>>;
  readonly downloadProgress: Readonly<Record<string, number>>;
  readonly isDownloading: Readonly<Record<string, boolean>>;
  readonly modelCacheDir: string | null;
  readonly onDownload: (modelId: string) => void;
  readonly onToggle: (modelId: string, enabled: boolean) => void;
  readonly onToggleDetails: (modelId: string) => void;
  /** The deferred search query, for highlighting and "id on demand". */
  readonly query: string;
  /** False at the narrow tier (< 640px). */
  readonly showTagline: boolean;
  /** True while the Type filter is All. */
  readonly showTypeTag: boolean;
}

export const CatalogRowActionsContext = createContext<CatalogRowActions | null>(null);

export function useCatalogRowActions(): CatalogRowActions {
  const actions = useContext(CatalogRowActionsContext);
  if (!actions) {
    throw new Error('Model Catalog cells must render inside CatalogRowActionsContext.');
  }
  return actions;
}
