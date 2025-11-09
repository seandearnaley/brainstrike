import type { IFileNode } from '@brainstrike/types';
import type { FixtureDefinition, FixtureTree } from './dev-fixture-types';
import { DEV_INLINE_FIXTURE } from './fixtures/dev-inline-fixture';
import type { DirectoryHandle, DirectoryReadOptions, FileHandle, FileSystemAdapter } from './types';

interface FixtureState {
  rootHandle: DirectoryHandle;
  directories: Map<string, IFileNode[]>;
  fileContents: Map<string, { content: string; size: number; lastModified: number }>;
}

export interface FixtureAdapterOptions {
  platform: DirectoryHandle['platform'];
  defaultFixture?: FixtureDefinition;
}

export interface FixtureControls {
  loadInlineFixture: (fixture?: FixtureDefinition) => Promise<DirectoryHandle>;
  clearInlineFixture: () => Promise<void>;
  isInlineFixtureActive: () => boolean;
  canLoadInlineFixture: boolean;
}

export type FixtureCapableFileSystemAdapter = FileSystemAdapter & FixtureControls;

function joinPath(parent: string, name: string): string {
  if (!parent) {
    return name;
  }
  return `${parent}/${name}`;
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

function buildFixtureState(
  definition: FixtureDefinition,
  platform: DirectoryHandle['platform']
): FixtureState {
  const directories = new Map<string, IFileNode[]>();
  const fileContents = new Map<string, { content: string; size: number; lastModified: number }>();
  const timestamp = Date.now();
  const rootHandle: DirectoryHandle = {
    path: definition.name,
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
    if (fixtureState?.directories.has(handle.path)) {
      return cloneNodes(fixtureState.directories.get(handle.path) ?? []);
    }
    return originalReadDirectory(handle, optionsArg);
  }

  async function readFile(handle: FileHandle): Promise<string> {
    if (fixtureState) {
      const record = fixtureState.fileContents.get(handle.path);
      if (record) {
        return record.content;
      }
    }
    return originalReadFile(handle);
  }

  async function exists(path: string): Promise<boolean> {
    if (fixtureState) {
      if (fixtureState.directories.has(path) || fixtureState.fileContents.has(path)) {
        return true;
      }
    }
    return originalExists(path);
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
