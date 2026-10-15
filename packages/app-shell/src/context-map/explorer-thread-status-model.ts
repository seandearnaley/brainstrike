/**
 * The Files explorer's "This thread" view (ADR-0021, BST-2018): the active
 * thread's context fold mapped onto explorer rows. Pure: the fold's files
 * are addressed by the host's identity (a database root id and a
 * folder-relative path); the explorer's rows by its adapter root id and tree
 * path. A file whose folder is not open in the explorer has no row.
 */
import { threadContextAt } from '@brainstrike/assistant-ui/thread-context-fold';
import type { ThreadContextRecord } from '@brainstrike/assistant-ui/thread-context-store';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type {
  ExplorerThreadFileStatus,
  ExplorerThreadFreshness,
  ExplorerThreadTouchKind,
} from '@brainstrike/file-explorer-ui/shell';
import { type ContextFileRow, contextFileRows, KIND_PRIORITY } from './context-map-model';
import { isComparableFileText, spanFreshness, splitFileLines } from './span-freshness';

/** An explorer folder: its adapter root id and the path its rows start with. */
export interface ExplorerFolder {
  readonly adapterRootId: string;
  readonly path: string;
}

export interface ExplorerThreadFile {
  /** The key the shared content owner reads the file by (folder-relative). */
  readonly contentKey: string;
  /** The file's row key: adapter root id and tree path. */
  readonly key: string;
  readonly kinds: readonly ExplorerThreadTouchKind[];
  readonly row: ContextFileRow;
}

export interface ExplorerThreadFiles {
  /** Touched files under each folder row, by the folder's row key. */
  readonly directories: ReadonlyMap<string, number>;
  readonly files: readonly ExplorerThreadFile[];
  /** Tree paths of the touched files. */
  readonly touchedPaths: readonly string[];
  /** Touched files whose folder is not open in the explorer. */
  readonly unmapped: number;
}

export const NO_EXPLORER_THREAD_FILES: ExplorerThreadFiles = {
  directories: new Map(),
  files: [],
  touchedPaths: [],
  unmapped: 0,
};

/** `relativePath` under `rootPath`, in the separator the root path uses. */
export function joinFolderPath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  const root = rootPath.replace(/[\\/]+$/u, '');
  const segments = relativePath.replace(/^\.?[\\/]+/u, '').split(/[\\/]/u);
  return [root, ...segments].join(separator);
}

function touchKinds(row: ContextFileRow): ExplorerThreadTouchKind[] {
  const kinds = new Set(row.spans.map(({ span }) => span.kind));
  return [...kinds].sort((a, b) => KIND_PRIORITY[b] - KIND_PRIORITY[a]);
}

/** Every touched file of the thread's latest turn, by explorer row. */
export function explorerThreadFiles(
  record: ThreadContextRecord,
  resolveFolder: (dbRootId: string) => ExplorerFolder | null
): ExplorerThreadFiles {
  const view = threadContextAt(record.snapshot, record.branchRunIds);
  const files: ExplorerThreadFile[] = [];
  const directories = new Map<string, number>();
  const touchedPaths = new Set<string>();
  let unmapped = 0;
  for (const row of contextFileRows(view.calls, 'all')) {
    const folder = row.rootId ? resolveFolder(row.rootId) : null;
    if (!(folder && row.path)) {
      unmapped += 1;
      continue;
    }
    const segments = row.path.replace(/^\.?[\\/]+/u, '').split(/[\\/]/u);
    const treePath = joinFolderPath(folder.path, row.path);
    files.push({
      contentKey: encodeFileSelection(folder.adapterRootId, row.path),
      key: encodeFileSelection(folder.adapterRootId, treePath),
      kinds: touchKinds(row),
      row,
    });
    touchedPaths.add(treePath);
    // Every folder row above the file counts it, the root's included.
    for (let depth = 0; depth < segments.length; depth += 1) {
      const directory =
        depth === 0 ? folder.path : joinFolderPath(folder.path, segments.slice(0, depth).join('/'));
      const key = encodeFileSelection(folder.adapterRootId, directory);
      directories.set(key, (directories.get(key) ?? 0) + 1);
    }
  }
  return { directories, files, touchedPaths: [...touchedPaths].sort(), unmapped };
}

const LINES_CACHE_LIMIT = 64;
const linesByText = new Map<string, readonly string[]>();

/** Split once per file text: the explorer re-renders on every content load. */
function cachedLines(text: string): readonly string[] {
  const cached = linesByText.get(text);
  if (cached) {
    return cached;
  }
  const lines = splitFileLines(text);
  if (linesByText.size >= LINES_CACHE_LIMIT) {
    const oldest = linesByText.keys().next();
    if (!oldest.done) {
      linesByText.delete(oldest.value);
    }
  }
  linesByText.set(text, lines);
  return lines;
}

/**
 * The file's delivered lines against its current text. Only reads and grep
 * hits kept their lines; a file with none of those, or whose text cannot be
 * compared, is `unknown`, never "unchanged".
 */
export function fileFreshness(
  file: ExplorerThreadFile,
  text: string | undefined,
  state: { readonly failed: boolean; readonly loading: boolean }
): ExplorerThreadFreshness {
  if (state.failed || (text !== undefined && !isComparableFileText(text))) {
    return 'unknown';
  }
  if (text === undefined || state.loading) {
    return 'checking';
  }
  const lines = cachedLines(text);
  const results = file.row.spans.map(({ span }) => spanFreshness(span, lines));
  if (results.includes('changed')) {
    return 'changed';
  }
  return results.includes('unchanged') ? 'unchanged' : 'unknown';
}

export function explorerThreadFileStatus(
  file: ExplorerThreadFile,
  freshness: ExplorerThreadFreshness
): ExplorerThreadFileStatus {
  return {
    editedWithoutRead: file.row.editedWithoutRead,
    freshness,
    gone: file.row.gone,
    kinds: file.kinds,
  };
}
