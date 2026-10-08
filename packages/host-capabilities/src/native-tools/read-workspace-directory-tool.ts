/**
 * The `readWorkspaceDirectory` native tool (BST-743): bounded depth-first
 * directory traversal (directories-first, collated ordering, hidden-path
 * filtering), offset paging, and self-fitting against the tool output budget.
 *
 * Leaf module: depends on the shared workspace-path helpers and root
 * resolution — never on `assistant-tools.ts`, so no import cycle is possible.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  fitItemsToCharBudget,
  type ReadWorkspaceDirectoryInput,
  type RuntimeData,
} from '@brainstrike/agent';
import { resolveWorkspaceRoot } from '@brainstrike/assistant-service/node-workspace-services';
import { defaultCollator } from '@brainstrike/utils/collator';
import {
  isHiddenPath,
  joinSegments,
  normalizeWorkspacePath,
  toPathSegments,
} from './workspace-path.js';
import { resolveWorkspaceAbsolutePath } from './workspace-path-resolution.js';

const DEFAULT_DIRECTORY_MAX_ENTRIES = 150;
const DEFAULT_DIRECTORY_DEPTH = 1;

interface DirectoryEntry {
  /** Present only in detail mode (concise entries are path + type). */
  depth?: number;
  path: string;
  size?: number;
  tokenCount?: number;
  type: 'directory' | 'file';
}

type FsDirent = import('node:fs').Dirent;

interface DirectoryTraversalOptions {
  baseSegments: readonly string[];
  depth: number;
  /** When true, entries include depth and file size (extra stat call per file). */
  detail: boolean;
  includeDirectories: boolean;
  includeFiles: boolean;
  includeHidden: boolean;
}

interface DirectoryTraversalState {
  entries: DirectoryEntry[];
  maxEntries: number;
  totalMatchedFiles: number;
  truncated: boolean;
}

interface DirectoryVisitContext {
  childAbsolutePath: string;
  childDepth: number;
  childPath: string;
  childSegments: string[];
}

function sortDirectoryEntries(entries: FsDirent[]): FsDirent[] {
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return defaultCollator.compare(a.name, b.name);
  });
}

function pushDirectoryEntry(state: DirectoryTraversalState, entry: DirectoryEntry): void {
  if (state.entries.length >= state.maxEntries) {
    state.truncated = true;
    return;
  }
  state.entries.push(entry);
}

function buildDirectoryVisitContext(
  dirent: FsDirent,
  currentAbsolutePath: string,
  relativeSegments: readonly string[],
  options: DirectoryTraversalOptions
): DirectoryVisitContext | undefined {
  const childSegments = [...relativeSegments, dirent.name];
  const childPath = joinSegments(options.baseSegments, childSegments);
  if (!options.includeHidden && isHiddenPath(childPath)) {
    return;
  }
  return {
    childAbsolutePath: path.join(currentAbsolutePath, dirent.name),
    childDepth: childSegments.length,
    childPath,
    childSegments,
  };
}

function processDirectoryEntry(
  context: DirectoryVisitContext,
  options: DirectoryTraversalOptions,
  state: DirectoryTraversalState
): boolean {
  if (options.includeDirectories && context.childDepth <= options.depth) {
    pushDirectoryEntry(state, {
      path: context.childPath,
      type: 'directory',
      ...(options.detail ? { depth: context.childDepth } : {}),
    });
  }
  return context.childDepth <= options.depth;
}

async function processFileEntry(
  context: DirectoryVisitContext,
  options: DirectoryTraversalOptions,
  state: DirectoryTraversalState
): Promise<void> {
  state.totalMatchedFiles += 1;
  if (!(options.includeFiles && context.childDepth <= options.depth + 1)) {
    return;
  }

  if (!options.detail) {
    pushDirectoryEntry(state, { path: context.childPath, type: 'file' });
    return;
  }

  let size: number | undefined;
  try {
    const stat = await fsPromises.stat(context.childAbsolutePath);
    size = stat.size;
  } catch {
    size = undefined;
  }

  pushDirectoryEntry(state, {
    depth: context.childDepth,
    path: context.childPath,
    type: 'file',
    ...(typeof size === 'number' ? { size } : {}),
  });
}

interface ReadWorkspaceDirectoryToolResult {
  count: number;
  entries: DirectoryEntry[];
  /** Actionable next step when the listing was truncated. */
  hint?: string;
  offset: number;
  path: string;
  /** Display name of the folder this listing is from (multi-root). */
  rootName: string;
  /** Entries collected by the traversal (lower bound when truncated). */
  totalEntries: number;
  totalMatchedFiles: number;
  truncated: boolean;
}

export async function runReadWorkspaceDirectory(
  input: ReadWorkspaceDirectoryInput,
  runtimeData: RuntimeData | undefined
): Promise<ReadWorkspaceDirectoryToolResult> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const requestedPath = input.path ?? '/';
  const normalizedPath = normalizeWorkspacePath(requestedPath);
  const resolvedBase = await resolveWorkspaceAbsolutePath(root.path, normalizedPath);

  const baseStats = await fsPromises.stat(resolvedBase.absolutePath);
  if (!baseStats.isDirectory()) {
    throw new Error(`Path "${normalizedPath}" is not a directory.`);
  }

  const depth = input.depth ?? DEFAULT_DIRECTORY_DEPTH;
  const maxEntries = input.maxEntries ?? DEFAULT_DIRECTORY_MAX_ENTRIES;
  const includeFiles = input.includeFiles ?? true;
  const includeDirectories = input.includeDirectories ?? true;
  const includeHidden = input.includeHidden ?? false;
  const detail = input.detail ?? false;
  const offset = input.offset ?? 0;

  const options: DirectoryTraversalOptions = {
    baseSegments: normalizedPath === '/' ? [] : toPathSegments(normalizedPath),
    depth,
    detail,
    includeDirectories,
    includeFiles,
    includeHidden,
  };
  const state: DirectoryTraversalState = {
    entries: [],
    // Collect through the requested page so offset paging can skip into it.
    maxEntries: offset + maxEntries,
    totalMatchedFiles: 0,
    truncated: false,
  };

  const visit = async (currentAbsolutePath: string, relativeSegments: readonly string[]) => {
    if (state.truncated) {
      return;
    }

    const dirEntries = sortDirectoryEntries(
      await fsPromises.readdir(currentAbsolutePath, { withFileTypes: true })
    );

    for (const dirent of dirEntries) {
      if (state.truncated) {
        return;
      }

      const context = buildDirectoryVisitContext(
        dirent,
        currentAbsolutePath,
        relativeSegments,
        options
      );
      if (!context) {
        continue;
      }

      if (dirent.isDirectory()) {
        const shouldRecurse = processDirectoryEntry(context, options, state);
        if (shouldRecurse) {
          await visit(context.childAbsolutePath, context.childSegments);
        }
        continue;
      }

      if (dirent.isFile()) {
        await processFileEntry(context, options, state);
      }
    }
  };

  await visit(resolvedBase.absolutePath, []);

  const pagedEntries = state.entries.slice(offset);
  // The hint is part of the fitted candidate so it can never push the final
  // result back over the budget.
  const { result } = fitItemsToCharBudget(
    pagedEntries,
    (entries): ReadWorkspaceDirectoryToolResult => {
      // Truncated when entries were dropped (traversal cap, paging, or budget fitting).
      const truncated = state.truncated || offset + entries.length < state.entries.length;
      const traversalNote = state.truncated
        ? ' The traversal stopped early, so totals are lower bounds.'
        : '';
      const hint = truncated
        ? `Showing entries ${offset + 1}-${offset + entries.length} of ${state.entries.length}+ under "${normalizedPath}".` +
          `${traversalNote} Continue with offset: ${offset + entries.length}, or list a more specific subdirectory.`
        : undefined;
      return {
        count: entries.length,
        entries,
        offset,
        path: normalizedPath,
        rootName: root.displayName,
        totalEntries: state.entries.length,
        totalMatchedFiles: state.totalMatchedFiles,
        truncated,
        ...(hint ? { hint } : {}),
      };
    }
  );
  return result;
}
