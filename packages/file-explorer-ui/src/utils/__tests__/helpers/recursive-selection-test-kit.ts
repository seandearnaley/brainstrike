import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { vi } from 'vitest';

export function createFileNode(
  overrides: Partial<IFileNode> & { name: string; path: string }
): IFileNode {
  return {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    rootFolderId: '/root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  };
}

export function createDirectoryNode(
  overrides: Partial<IFileNode> & { name: string; path: string }
): IFileNode {
  return {
    children: [],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'unloaded',
    rootFolderId: '/root',
    selectionState: 'unchecked',
    type: 'directory',
    ...overrides,
  };
}

export function createMockAdapter(directoryMap: Record<string, IFileNode[]>): FileSystemAdapter {
  const readDirectory = vi.fn(async (handle: DirectoryHandle) => directoryMap[handle.path] ?? []);

  return {
    exists: vi.fn(),
    readDirectory,
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
  } as unknown as FileSystemAdapter;
}
