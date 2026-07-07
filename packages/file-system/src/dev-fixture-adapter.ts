import type { FileForIndexingResolution, IFileNode } from '@brainstrike/types';
import { createLogger, fileNodeCollator } from '@brainstrike/utils';
import type { FixtureDefinition, FixtureLoadOptions, FixtureTree } from './dev-fixture-types';
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

interface FixtureState {
  directories: Map<string, IFileNode[]>;
  fileContents: Map<string, { content: string; size: number; lastModified: number }>;
  rootHandle: DirectoryHandle;
}

export interface FixtureAdapterOptions {
  defaultFixture?: FixtureDefinition;
  platform: DirectoryHandle['platform'];
}

export interface FixtureControls {
  canLoadInlineFixture: boolean;
  clearInlineFixture: () => Promise<void>;
  isInlineFixtureActive: () => boolean;
  loadInlineFixture: (fixture?: FixtureDefinition) => Promise<DirectoryHandle>;
  setInlineFixtureOptions?: (options?: FixtureLoadOptions) => void;
}

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
    return fileNodeCollator.compare(a.name, b.name);
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

async function waitForFixtureDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function buildFixtureState(
  definition: FixtureDefinition,
  platform: DirectoryHandle['platform'],
  rootId: string
): FixtureState {
  const directories = new Map<string, IFileNode[]>();
  const fileContents = new Map<string, { content: string; size: number; lastModified: number }>();
  const timestamp = Date.now();

  const rootPath = definition.name;

  // Stamp a durable rootId ONCE at the fixture boundary. loadInlineFixture (inject
  // → setRoot) and restoreLastFolder (auto-restore → addOrFocusHandle) both return
  // this same rootHandle object, so the inject and restore share one rootId and the
  // reducer reconciles them to a SINGLE root (identity is rootId-only — an unstamped
  // handle would be minted twice and render the file tree as two roots).
  const rootHandle: DirectoryHandle = {
    kind: 'directory',
    name: definition.name,
    path: rootPath,
    platform,
    rootId,
  };

  const createDirectoryHandle = (path: string, name: string) => ({
    kind: 'directory',
    name,
    path,
    platform,
  });

  const createFileHandle = (path: string, name: string, size: number): FileHandle => ({
    kind: 'file',
    name,
    path,
    platform,
    size,
  });

  const getDefaultFileContent = (name: string): string => `${name} content`;

  const walk = (tree: FixtureTree, currentPath: string, rootFolderId: string): void => {
    const entries: IFileNode[] = [];

    for (const [name, value] of Object.entries(tree)) {
      const fullPath = joinPath(currentPath, name);
      if (typeof value === 'string' || value === null) {
        const content = typeof value === 'string' ? value : getDefaultFileContent(name);
        const size = content.length;
        fileContents.set(fullPath, { content, lastModified: timestamp, size });
        entries.push({
          depth: 0,
          handle: createFileHandle(fullPath, name, size) as unknown as FileSystemFileHandle,
          isVisible: true,
          lastModified: timestamp,
          name,
          path: fullPath,
          rootFolderId,
          selectionState: 'unchecked',
          size,
          type: 'file',
        });
        continue;
      }

      const dirHandle = createDirectoryHandle(fullPath, name);
      entries.push({
        children: [],
        depth: 0,
        handle: dirHandle as unknown as FileSystemDirectoryHandle,
        isVisible: true,
        name,
        path: fullPath,
        rootFolderId,
        selectionState: 'unchecked',
        type: 'directory',
      });

      walk(value, fullPath, rootFolderId);
    }

    directories.set(currentPath, sortNodes(entries));
  };

  walk(definition.tree, rootHandle.path, rootHandle.path);

  // Ensure every directory path has a map entry, even if empty
  if (!directories.has(rootHandle.path)) {
    directories.set(rootHandle.path, []);
  }

  return { directories, fileContents, rootHandle };
}

function resolveFixtureLookupPath(fixtureState: FixtureState, path: string): string {
  if (fixtureState.directories.has(path) || fixtureState.fileContents.has(path)) {
    return path;
  }

  const { rootHandle } = fixtureState;
  if (!rootHandle.rootId) {
    return path;
  }

  if (path === rootHandle.rootId) {
    return rootHandle.path;
  }

  const rootIdPrefix = `${rootHandle.rootId}/`;
  if (path.startsWith(rootIdPrefix)) {
    const remainder = path.slice(rootIdPrefix.length);
    if (remainder === rootHandle.path || remainder.startsWith(`${rootHandle.path}/`)) {
      return remainder;
    }
    return joinPath(rootHandle.path, remainder);
  }

  return path;
}

export function createFixtureCapableAdapter<T extends FileSystemAdapter>(
  adapter: T,
  options: FixtureAdapterOptions
): T & FixtureControls {
  const platform = options.platform;
  const defaultFixture = options.defaultFixture ?? DEV_INLINE_FIXTURE;
  let fixtureState: FixtureState | null = null;
  let fixtureLoadOptions: FixtureLoadOptions = {};
  const fixtureRootIdsByName = new Map<string, string>();

  const originalRequestDirectoryAccess = adapter.requestDirectoryAccess.bind(adapter);
  const originalReadDirectory = adapter.readDirectory.bind(adapter);
  const originalReadFile = adapter.readFile.bind(adapter);
  const originalExists = adapter.exists.bind(adapter);
  const originalReadFileByPath = (
    adapter as { readFileByPath?: ((path: string) => Promise<string>) | undefined }
  ).readFileByPath?.bind(adapter);
  const originalResolveFileForIndexing = (
    adapter as {
      resolveFileForIndexing?: ((path: string) => Promise<FileForIndexingResolution>) | undefined;
    }
  ).resolveFileForIndexing?.bind(adapter);
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
      await waitForFixtureDelay(fixtureLoadOptions.directoryReadDelayMs ?? 0);
      const lookupPath = resolveFixtureLookupPath(fixtureState, handle.path);
      // When fixture is active, only serve data from the fixture
      if (fixtureState.directories.has(lookupPath)) {
        return cloneNodes(fixtureState.directories.get(lookupPath) ?? []);
      }
      // Path not found in fixture - this shouldn't happen if fixture is properly built
      logger.warn('Path not found in fixture', {
        availablePaths: Array.from(fixtureState.directories.keys()),
        path: handle.path,
      });
      return [];
    }
    return originalReadDirectory(handle, optionsArg);
  }

  async function readFile(handle: FileHandle): Promise<string> {
    if (fixtureState) {
      const record = fixtureState.fileContents.get(
        resolveFixtureLookupPath(fixtureState, handle.path)
      );
      if (record) {
        return record.content;
      }
      logger.warn('File not found in fixture', { path: handle.path });
      return '';
    }
    return originalReadFile(handle);
  }

  async function exists(path: string): Promise<boolean> {
    if (fixtureState) {
      const lookupPath = resolveFixtureLookupPath(fixtureState, path);
      if (fixtureState.directories.has(lookupPath) || fixtureState.fileContents.has(lookupPath)) {
        return true;
      }
    }
    return originalExists(path);
  }

  async function readFileByPath(path: string): Promise<string> {
    if (fixtureState) {
      const record = fixtureState.fileContents.get(resolveFixtureLookupPath(fixtureState, path));
      if (record) {
        return record.content;
      }
      throw new Error(`File not found in fixture: ${path}`);
    }
    if (!originalReadFileByPath) {
      throw new Error('Direct path reads are not supported by this adapter');
    }
    return originalReadFileByPath(path);
  }

  // Mirrors WebFileSystemAdapter.resolveFileForIndexing for the in-memory
  // fixture. We deliberately return `kind: 'content'` instead of fabricating a
  // synthetic FileSystemFileHandle: only the browser's real handles have
  // structured-clone support, so a custom handle's methods would be stripped
  // when posted to the indexer worker (`async()=>... could not be cloned`).
  // Returning pre-loaded bytes keeps the worker boundary serializable and
  // exercises the same FileToIndex.content code path that Electron uses.
  async function resolveFileForIndexing(path: string): Promise<FileForIndexingResolution> {
    if (fixtureState) {
      const record = fixtureState.fileContents.get(resolveFixtureLookupPath(fixtureState, path));
      if (!record) {
        throw new Error(`File not found in fixture: ${path}`);
      }
      return { content: record.content, fileSize: record.size, kind: 'content' };
    }
    if (!originalResolveFileForIndexing) {
      throw new Error('resolveFileForIndexing is not supported by this adapter');
    }
    return originalResolveFileForIndexing(path);
  }

  async function readDirectoryStreaming(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    optionsArg?: StreamingDirectoryReadOptions
  ): Promise<void> {
    if (fixtureState) {
      await waitForFixtureDelay(fixtureLoadOptions.directoryReadDelayMs ?? 0);
      const lookupPath = resolveFixtureLookupPath(fixtureState, handle.path);
      streamNodesInBatches(
        cloneNodes(fixtureState.directories.get(lookupPath) ?? []),
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
    const rootId = fixtureRootIdsByName.get(fixture.name) ?? crypto.randomUUID();
    fixtureRootIdsByName.set(fixture.name, rootId);
    fixtureState = buildFixtureState(fixture, platform, rootId);
    return fixtureState.rootHandle;
  }

  async function clearInlineFixture(): Promise<void> {
    fixtureState = null;
  }

  function isInlineFixtureActive(): boolean {
    return fixtureState !== null;
  }

  function setInlineFixtureOptions(nextOptions?: FixtureLoadOptions): void {
    fixtureLoadOptions = nextOptions ?? {};
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
  if (originalReadFileByPath) {
    (
      decorated as T & {
        readFileByPath?: (path: string) => Promise<string>;
      }
    ).readFileByPath = readFileByPath;
  }
  // Always wire `resolveFileForIndexing` so fixture-driven e2e tests can serve
  // file bytes for unexpanded-subfolder selections. When no fixture is loaded
  // we forward to the underlying adapter (which on web returns a real handle).
  // The fixture branch returns pre-loaded `kind: 'content'` so the worker
  // never tries to call `.getFile()` on a structured-clone-stripped handle.
  (
    decorated as T & {
      resolveFileForIndexing?: (path: string) => Promise<FileForIndexingResolution>;
    }
  ).resolveFileForIndexing = resolveFileForIndexing;
  if (adapter.restoreLastFolder) {
    decorated.restoreLastFolder = restoreLastFolder;
  }
  decorated.loadInlineFixture = loadInlineFixture;
  decorated.clearInlineFixture = clearInlineFixture;
  decorated.isInlineFixtureActive = isInlineFixtureActive;
  decorated.canLoadInlineFixture = true;
  decorated.setInlineFixtureOptions = setInlineFixtureOptions;

  // Forward getHandleCache if available (required for web persistence via useRestoreAccess)
  const adapterWithCache = adapter as { getHandleCache?: () => unknown };
  if (typeof adapterWithCache.getHandleCache === 'function') {
    (decorated as { getHandleCache?: () => unknown }).getHandleCache =
      adapterWithCache.getHandleCache.bind(adapter);
  }

  return decorated;
}

export function isFixtureCapableAdapter(
  adapter: FileSystemAdapter
): adapter is FixtureCapableFileSystemAdapter {
  return typeof (adapter as FixtureCapableFileSystemAdapter).loadInlineFixture === 'function';
}
