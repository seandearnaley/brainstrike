import type { IFileNode } from '@brainstrike/types';
import {
  createWorkspaceIgnoreMatcher,
  type WorkspaceIgnoreMatcher,
  type WorkspaceIgnoreSources,
} from '@brainstrike/utils';
import type { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils/background-indexing-policy';
import { fileNodeToFileHandle } from './file-node-handles.js';
import type { WorkspaceDiscoveryDeps } from './workspace-scan-nodes.js';
import {
  getParentRelativePath,
  isUnderTruncatedDirectory,
  toRootRelativePath,
} from './workspace-scan-paths.js';

const IGNORE_FILES = [
  ['.gitignore', 'gitignore'],
  ['.ignore', 'ignore'],
  ['.rgignore', 'rgignore'],
  ['.llmignore', 'llmignore'],
  ['.brainstrikeignore', 'brainstrikeignore'],
] as const satisfies readonly (readonly [string, keyof WorkspaceIgnoreSources])[];

export function isWorkspaceIgnoreFile(name: string): boolean {
  return IGNORE_FILES.some(([fileName]) => name === fileName);
}

/** Scan-local rules through the same authorized capabilities as source discovery. */
export function createWorkspaceScanIgnorePolicy(args: {
  readonly deps: WorkspaceDiscoveryDeps;
  readonly entryPolicy: ReturnType<typeof createBackgroundIndexingEntryPolicy>;
  readonly rootPath: string;
  readonly signal: AbortSignal;
}): {
  readonly deps: WorkspaceDiscoveryDeps;
  readonly entryPolicy: ReturnType<typeof createBackgroundIndexingEntryPolicy>;
} {
  const matchers = new Map<string, WorkspaceIgnoreMatcher>();
  const scopes = new Map<string, Promise<WorkspaceIgnoreSources>>();
  const unknownDirectories: string[] = [];
  const resolveFileHandleByPath = args.deps.fileSystemAdapter.resolveFileHandleByPath;
  const sources = (
    directory: string,
    nodes: readonly IFileNode[]
  ): Promise<WorkspaceIgnoreSources> => {
    const existing = scopes.get(directory);
    if (existing) {
      return existing;
    }
    const pending = (async () => {
      const result: WorkspaceIgnoreSources = {};
      for (const [name, key] of IGNORE_FILES) {
        const node = nodes.find((entry) => entry.type === 'file' && entry.name === name);
        if (!node) {
          continue;
        }
        args.signal.throwIfAborted();
        result[key] = await args.deps.fileSystemAdapter.readFile(fileNodeToFileHandle(node));
        args.signal.throwIfAborted();
      }
      return result;
    })();
    scopes.set(directory, pending);
    return pending;
  };
  const matcherFor = (relativePath: string): WorkspaceIgnoreMatcher | undefined => {
    let directory = getParentRelativePath(relativePath) ?? '';
    while (true) {
      const matcher = matchers.get(directory);
      if (matcher || directory === '') {
        return matcher;
      }
      directory = getParentRelativePath(directory) ?? '';
    }
  };
  return {
    deps: {
      fileSystemAdapter: {
        readFile: (handle) => args.deps.fileSystemAdapter.readFile(handle),
        ...(resolveFileHandleByPath
          ? {
              resolveFileHandleByPath: (path: string) =>
                resolveFileHandleByPath.call(args.deps.fileSystemAdapter, path),
            }
          : {}),
        readDirectory: async (handle, options) => {
          args.signal.throwIfAborted();
          const nodes = await args.deps.fileSystemAdapter.readDirectory(handle, options);
          args.signal.throwIfAborted();
          const directory = toRootRelativePath(args.rootPath, handle.path);
          if (nodes.some((node) => node.type === 'truncated')) {
            // The omitted entries may include rules. Keep the truncation marker
            // and existing rows, but admit no source under this unknown scope.
            if (!unknownDirectories.includes(directory)) {
              unknownDirectories.push(directory);
            }
            scopes.set(directory, Promise.resolve({}));
          }
          await sources(directory, nodes);
          const chain = [directory];
          let ancestorDirectory = directory;
          while (ancestorDirectory !== '') {
            ancestorDirectory = getParentRelativePath(ancestorDirectory) ?? '';
            chain.unshift(ancestorDirectory);
          }
          const matcher = createWorkspaceIgnoreMatcher();
          for (const ancestor of chain) {
            const pending = scopes.get(ancestor);
            if (!pending) {
              throw new Error('Workspace ignore rules require the admitted ancestor listing.');
            }
            matcher.push(ancestor, await pending);
          }
          matchers.set(directory, matcher);
          return nodes;
        },
      },
    },
    entryPolicy: {
      ...args.entryPolicy,
      shouldIncludeFile: (input) =>
        !(
          isUnderTruncatedDirectory(input.relativePath, unknownDirectories) ||
          matcherFor(input.relativePath)?.ignoresFile(input.relativePath)
        ) && args.entryPolicy.shouldIncludeFile(input),
      // A scoped directory's first check precedes its ancestor listing. Its
      // resolver repeats the gate after that listing; actual descent never skips rules.
      shouldTraverseDirectory: (input) =>
        !(
          isUnderTruncatedDirectory(input.relativePath, unknownDirectories) ||
          matcherFor(input.relativePath)?.ignoresDirectory(input.relativePath)
        ) && args.entryPolicy.shouldTraverseDirectory(input),
    },
  };
}
