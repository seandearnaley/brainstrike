import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FileHandle, IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFileHandleMap,
  buildSyntheticElectronHandle,
  getSlashPathFileName,
  type HandleInfo,
} from '../indexing/background-token-indexer-handles';

function fileNode(handle: IFileNode['handle']): IFileNode {
  return {
    depth: 0,
    handle,
    name: 'file.txt',
    path: 'src/file.txt',
    rootFolderId: 'root-id',
    selectionState: 'unchecked',
    size: 1024,
    type: 'file',
  };
}

describe('buildFileHandleMap', () => {
  it.each(['raw', 'canonical'] as const)(
    'retains the readable capability of a %s web handle',
    async (form) => {
      const file = new File(['contents'], 'file.txt');
      const rawHandle: FileSystemFileHandle = {
        createWritable: vi.fn(),
        getFile: vi.fn().mockResolvedValue(file),
        isSameEntry: vi.fn(),
        kind: 'file',
        name: 'file.txt',
        queryPermission: vi.fn(),
        requestPermission: vi.fn(),
      };
      const descriptor: FileHandle = {
        _internal: rawHandle,
        kind: 'file',
        name: 'file.txt',
        path: 'src/file.txt',
        platform: 'web',
        rootId: 'root-id',
      };
      const handles = new Map<string, HandleInfo>();
      buildFileHandleMap([fileNode(form === 'raw' ? rawHandle : descriptor)], handles);

      const result = handles.get(encodeFileSelection('root-id', 'src/file.txt'));
      expect(result?.webHandle).toBe(rawHandle);
      expect(result?.fileName).toBe('file.txt');
      expect(result?.fileSize).toBe(1024);
      expect(rawHandle.getFile).not.toHaveBeenCalled();
      expect(await result?.webHandle?.getFile()).toBe(file);
    }
  );

  it('preserves the canonical native descriptor and its root identity', () => {
    const descriptor: FileHandle = {
      kind: 'file',
      name: 'file.txt',
      path: '/workspace/src/file.txt',
      platform: 'electron',
      rootId: 'root-id',
    };
    const handles = new Map<string, HandleInfo>();
    buildFileHandleMap([fileNode(descriptor)], handles);

    const result = handles.get(encodeFileSelection('root-id', 'src/file.txt'));
    expect(result?.electronHandle).toBe(descriptor);
    expect(result?.webHandle).toBeUndefined();
    expect(result?.fileName).toBe('file.txt');
    expect(result?.fileSize).toBe(1024);
  });
});

describe('getSlashPathFileName', () => {
  it('extracts file names without array allocation and preserves edge-case behavior', () => {
    expect(getSlashPathFileName('src/index.ts')).toBe('index.ts');
    expect(getSlashPathFileName('README.md')).toBe('README.md');
    expect(getSlashPathFileName('')).toBe('');
    expect(getSlashPathFileName('src/')).toBe('');
  });
});

describe('buildSyntheticElectronHandle', () => {
  it('uses slash-path file names and rejects empty names', () => {
    const root = '/workspace';

    expect(
      buildSyntheticElectronHandle({
        filePath: 'src/index.ts',
        fileSize: 123,
        folderId: root,
      })?.fileName
    ).toBe('index.ts');
    expect(
      buildSyntheticElectronHandle({
        filePath: 'README.md',
        fileSize: 123,
        folderId: root,
      })?.fileName
    ).toBe('README.md');
    expect(
      buildSyntheticElectronHandle({
        filePath: '',
        fileSize: 123,
        folderId: root,
      })
    ).toBeNull();
    expect(
      buildSyntheticElectronHandle({
        filePath: 'src/',
        fileSize: 123,
        folderId: root,
      })
    ).toBeNull();
  });

  it('collapses slash-only relative path separators when building synthetic paths', () => {
    expect(
      buildSyntheticElectronHandle({
        filePath: '/src//components/button.tsx',
        fileSize: 123,
        folderId: '/workspace///',
      })?.electronHandle?.path
    ).toBe('/workspace/src/components/button.tsx');
    expect(
      buildSyntheticElectronHandle({
        filePath: '/src\\literal//button.tsx',
        fileSize: 123,
        folderId: 'C:\\workspace\\',
      })?.electronHandle?.path
    ).toBe('C:\\workspace\\src\\literal\\button.tsx');
  });
});
