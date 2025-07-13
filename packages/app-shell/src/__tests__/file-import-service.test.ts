import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileImportService } from '../file-import-service';

// Mock dependencies to avoid complex setup
vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => ({
    bulkImport: vi.fn(),
  }),
  usePGliteDatabase: () => null,
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: {
      readFile: vi.fn(),
    },
  }),
}));

vi.mock('@brainstrike/utils', () => ({
  decodeFileSelection: vi.fn(() => ({
    folderId: 'test',
    path: '/test/path',
  })),
  fileContent: {
    isBinaryExtension: vi.fn(() => false),
    isTextExtension: vi.fn(() => true),
    isTextContent: vi.fn(() => true),
  },
  fileExplorer: {
    findNodeByPath: vi.fn(() => null),
    getFileExtension: vi.fn(() => '.txt'),
  },
}));

describe('useFileImportService', () => {
  it('should initialize with correct default state', () => {
    const { result } = renderHook(() => useFileImportService());

    expect(result.current.isImporting).toBe(false);
    expect(result.current.progress).toBe(null);
    expect(typeof result.current.importFiles).toBe('function');
  });

  it('should accept options parameter', () => {
    const options = {
      onProgress: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    const { result } = renderHook(() => useFileImportService(options));

    expect(result.current.isImporting).toBe(false);
    expect(result.current.progress).toBe(null);
    expect(typeof result.current.importFiles).toBe('function');
  });

  it('should handle empty options', () => {
    const { result } = renderHook(() => useFileImportService({}));

    expect(result.current.isImporting).toBe(false);
    expect(result.current.progress).toBe(null);
    expect(typeof result.current.importFiles).toBe('function');
  });
});
