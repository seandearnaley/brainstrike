/**
 * "Changed since read" for one context-map file row (BST-2017), checked
 * lazily against the explorer's shared content owner: the file is read
 * fresh when the row is shown, and again when the watcher reports a change
 * under its root. A file the explorer cannot map or read stays `unknown`.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  refreshReachesFile,
  useWorkspaceTabs,
} from '@brainstrike/file-explorer-ui/shell';
import { useEffect, useMemo } from 'react';
import { useOptionalRootIdentity } from '../roots/root-identity-context';
import type { ContextFileRow } from './context-map-model';
import {
  isComparableFileText,
  type SpanFreshness,
  spanFreshness,
  splitFileLines,
} from './span-freshness';

export interface RowFreshness {
  /** One entry per `row.spans`, in the same order. */
  readonly bySpan: readonly SpanFreshness[];
  readonly changed: boolean;
  /** `unavailable`: the file has no explorer mapping or could not be read. */
  readonly status: 'checked' | 'checking' | 'unavailable';
}

export function useRowFreshness(row: ContextFileRow | undefined): RowFreshness | undefined {
  const { fileContentErrors, fileContents, loadingFiles, onRetryFileContent } = useWorkspaceTabs();
  const identity = useOptionalRootIdentity();
  const rootId = row?.rootId;
  const path = row?.path;
  const key = useMemo(() => {
    if (!(rootId && path && identity)) {
      return null;
    }
    // Tool paths are root-relative, the same form quick open and search results open.
    const adapterRootId = identity.resolveAdapterRootId(rootId);
    return adapterRootId === null ? null : encodeFileSelection(adapterRootId, path);
  }, [identity, path, rootId]);

  useEffect(() => {
    if (key === null) {
      return;
    }
    onRetryFileContent(key);
    const onRefresh = (event: Event) => {
      if (refreshReachesFile((event as FileExplorerRefreshEvent).detail, key)) {
        onRetryFileContent(key);
      }
    };
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, onRefresh);
    };
  }, [key, onRetryFileContent]);

  const text = key === null ? undefined : fileContents[key];
  const lines = useMemo(
    () => (isComparableFileText(text) ? splitFileLines(text) : undefined),
    [text]
  );

  if (!row) {
    return undefined;
  }
  const bySpan = row.spans.map(({ span }) => spanFreshness(span, lines));
  let status: RowFreshness['status'] = 'checked';
  if (key === null || fileContentErrors.has(key) || (text !== undefined && lines === undefined)) {
    status = 'unavailable';
  } else if (lines === undefined || loadingFiles.has(key)) {
    // The shared loader evicts a file's text when it reloads, so a reload reads as checking.
    status = 'checking';
  }
  return { bySpan, changed: status === 'checked' && bySpan.includes('changed'), status };
}
