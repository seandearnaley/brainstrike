import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import type { FixtureDefinition, FixtureTree } from './dev-fixture-types';
import { DEV_INLINE_FIXTURE } from './fixtures/dev-inline-fixture';
import type {
  DirectoryHandle,
  DirectoryReadOptions,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
  StreamingDirectoryReadOptions,
} from './types';

const logger = createLogger('FixtureAdapter');

type FixtureState = {
  rootHandle: DirectoryHandle;
  directories: Map<string, IFileNode[]>;
  fileContents: Map<string, { content: string; size: number; lastModified: number }>;
};

export type FixtureAdapterOptions = {
  platform: DirectoryHandle['platform'];
  defaultFixture?: FixtureDefinition;
};

export type FixtureControls = {
  loadInlineFixture: (fixture?: FixtureDefinition) => Promise<DirectoryHandle>;
  clearInlineFixture: () => Promise<void>;
  isInlineFixtureActive: () => boolean;
  canLoadInlineFixture: boolean;
};

export type FixtureCapableFileSystemAdapter = FileSystemAdapter & FixtureControls;

/**
 * Cross-platform path joining using forward slashes (works in both Node.js and browser).
 * Always uses POSIX-style paths for consistency.
 */
function joinPath(parent: string, name: string): string {
  if (!parent) {
    return name;
  }
  // Remove trailing slash from parent if present
  const cleanParent = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return `${cleanParent}/${name}`;
}

function sortNodes(nodes: IFileNode[]): IFileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function cloneNodes(nodes: IFileNode[]): IFileNode[] {
  return nodes.map((node) => {
    const { children, ...rest } = node;
    const clone: IFileNode = { ...rest } as IFileNode;
    if (children) {
      clone.children = cloneNodes(children);
    }
    return clone;
  });
}

function streamNodesInBatches(
  nodes: IFileNode[],
  onBatch: DirectoryStreamCallback,
  options?: StreamingDirectoryReadOptions
): void {
  const batchSize = options?.batchSize ?? 50;
  const signal = options?.signal;

  let batch: IFileNode[] = [];
  let total = 0;

  for (const node of nodes) {
    if (signal?.aborted) {
      break;
    }
    batch.push(node);
    total++;
    if (batch.length >= batchSize) {
      onBatch(batch, { done: false, total });
      batch = [];
    }
  }

  // Emit completion signal (match Web adapter semantics)
  if (batch.length > 0 || total === 0) {
    onBatch(batch, { done: true, total });
  } else {
    onBatch([], { done: true, total });
  }
}

function buildFixtureState(
  definition: FixtureDefinition,
  platform: DirectoryHandle['platform']
): FixtureState {
  const directories = new Map<string, IFileNode[]>();
  const fileContents = new Map<string, { content: string; size: number; lastModified: number }>();
  const timestamp = Date.now();

  // For web, use empty string as root path (relative paths)
  // For electron, use the definition name (absolute paths)
  const rootPath = platform === 'web' ? '' : definition.name;

  const rootHandle: DirectoryHandle = {
    path: rootPath,
    name: definition.name,
    kind: 'directory',
    platform,
  };

  const createDirectoryHandle = (path: string, name: string) => ({
    path,
    name,
    kind: 'directory',
    platform,
  });

  const createFileHandle = (path: string, name: string, size: number): FileHandle => ({
    path,
    name,
    kind: 'file',
    platform,
    size,
  });

  const walk = (tree: FixtureTree, currentPath: string, rootFolderId: string): void => {
    const entries: IFileNode[] = [];

    for (const [name, value] of Object.entries(tree)) {
      const fullPath = joinPath(currentPath, name);
      if (typeof value === 'string') {
        const size = value.length;
        fileContents.set(fullPath, { content: value, size, lastModified: timestamp });
        entries.push({
          name,
          path: fullPath,
          type: 'file',
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId,
          isVisible: true,
          size,
          lastModified: timestamp,
          handle: createFileHandle(fullPath, name, size) as unknown as FileSystemFileHandle,
        });
        continue;
      }

      const dirHandle = createDirectoryHandle(fullPath, name);
      entries.push({
        name,
        path: fullPath,
        type: 'directory',
        depth: 0,
        selectionState: 'unchecked',
        children: [],
        rootFolderId,
        isVisible: true,
        handle: dirHandle as unknown as FileSystemDirectoryHandle,
      });

      walk(value, fullPath, rootFolderId);
    }

    directories.set(currentPath, sortNodes(entries));
  };

  walk(definition.tree, rootHandle.path, rootHandle.name);

  // Ensure every directory path has a map entry, even if empty
  if (!directories.has(rootHandle.path)) {
    directories.set(rootHandle.path, []);
  }

  return { rootHandle, directories, fileContents };
}

export function createFixtureCapableAdapter<T extends FileSystemAdapter>(
  adapter: T,
  options: FixtureAdapterOptions
): T & FixtureControls {
  const platform = options.platform;
  const defaultFixture = options.defaultFixture ?? DEV_INLINE_FIXTURE;
  let fixtureState: FixtureState | null = null;

  const originalRequestDirectoryAccess = adapter.requestDirectoryAccess.bind(adapter);
  const originalReadDirectory = adapter.readDirectory.bind(adapter);
  const originalReadFile = adapter.readFile.bind(adapter);
  const originalExists = adapter.exists.bind(adapter);
  const originalRestoreLastFolder = adapter.restoreLastFolder?.bind(adapter);
  const originalReadDirectoryStreaming = adapter.readDirectoryStreaming?.bind(adapter);

  async function requestDirectoryAccess(): Promise<DirectoryHandle> {
    if (fixtureState) {
      return fixtureState.rootHandle;
    }
    return originalRequestDirectoryAccess();
  }

  async function readDirectory(
    handle: DirectoryHandle,
    optionsArg?: DirectoryReadOptions
  ): Promise<IFileNode[]> {
    if (fixtureState) {
      // When fixture is active, only serve data from the fixture
      if (fixtureState.directories.has(handle.path)) {
        return cloneNodes(fixtureState.directories.get(handle.path) ?? []);
      }
      // Path not found in fixture - this shouldn't happen if fixture is properly built
      logger.warn('Path not found in fixture', {
        path: handle.path,
        availablePaths: Array.from(fixtureState.directories.keys()),
      });
      return [];
    }
    return originalReadDirectory(handle, optionsArg);
  }

  async function readFile(handle: FileHandle): Promise<string> {
    if (fixtureState) {
      const record = fixtureState.fileContents.get(handle.path);
      if (record) {
        return record.content;
      }
      logger.warn('File not found in fixture', { path: handle.path });
      return '';
    }
    return originalReadFile(handle);
  }

  async function exists(path: string): Promise<boolean> {
    if (
      fixtureState &&
      (fixtureState.directories.has(path) || fixtureState.fileContents.has(path))
    ) {
      return true;
    }
    return originalExists(path);
  }

  async function readDirectoryStreaming(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    optionsArg?: StreamingDirectoryReadOptions
  ): Promise<void> {
    if (fixtureState) {
      streamNodesInBatches(
        cloneNodes(fixtureState.directories.get(handle.path) ?? []),
        onBatch,
        optionsArg
      );
      return;
    }

    if (originalReadDirectoryStreaming) {
      return originalReadDirectoryStreaming(handle, onBatch, optionsArg);
    }

    // Should only be called when streaming is supported; fail loudly if invoked otherwise.
    throw new Error('Streaming directory reads are not supported by this adapter');
  }

  async function restoreLastFolder(): Promise<DirectoryHandle | null> {
    if (fixtureState) {
      return fixtureState.rootHandle;
    }
    if (originalRestoreLastFolder) {
      return originalRestoreLastFolder();
    }
    return null;
  }

  async function loadInlineFixture(
    fixture: FixtureDefinition = defaultFixture
  ): Promise<DirectoryHandle> {
    fixtureState = buildFixtureState(fixture, platform);
    return fixtureState.rootHandle;
  }

  async function clearInlineFixture(): Promise<void> {
    fixtureState = null;
  }

  function isInlineFixtureActive(): boolean {
    return fixtureState !== null;
  }

  const decorated = adapter as T & FixtureControls;
  decorated.requestDirectoryAccess = requestDirectoryAccess;
  decorated.readDirectory = readDirectory;
  // Don't change the adapter's streaming capability when the fixture is inactive.
  // If the underlying adapter doesn't support streaming (e.g. Electron),
  // advertising a streaming method here would cause callers to route into it and fail.
  if (originalReadDirectoryStreaming) {
    decorated.readDirectoryStreaming = readDirectoryStreaming;
  }
  decorated.readFile = readFile;
  decorated.exists = exists;
  if (adapter.restoreLastFolder) {
    decorated.restoreLastFolder = restoreLastFolder;
  }
  decorated.loadInlineFixture = loadInlineFixture;
  decorated.clearInlineFixture = clearInlineFixture;
  decorated.isInlineFixtureActive = isInlineFixtureActive;
  decorated.canLoadInlineFixture = true;

  return decorated;
}

export function isFixtureCapableAdapter(
  adapter: FileSystemAdapter
): adapter is FixtureCapableFileSystemAdapter {
  return typeof (adapter as FixtureCapableFileSystemAdapter).loadInlineFixture === 'function';
}
