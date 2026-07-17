/**
 * File Tree Tool Tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQueryFileTreeTool,
  FILE_TREE_ERROR_MESSAGES,
  type FileEntry,
  type FileTreeToolDependencies,
  QUERY_FILE_TREE_TOOL_ID,
} from '../tools/file-tree-tool';

describe('File Tree Tool', () => {
  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
  };

  const sampleFiles: FileEntry[] = [
    {
      childCount: 5,
      id: 'file-1',
      isChunked: false,
      isDirectory: true,
      name: 'src',
      path: '/project/src',
      size: null,
      tokenCount: null,
    },
    {
      id: 'file-2',
      isChunked: true,
      isDirectory: false,
      name: 'index.ts',
      path: '/project/src/index.ts',
      size: 2048,
      tokenCount: 500,
    },
    {
      id: 'file-3',
      isChunked: true,
      isDirectory: false,
      name: 'utils.ts',
      path: '/project/src/utils.ts',
      size: 1024,
      tokenCount: 250,
    },
  ];

  let deps: FileTreeToolDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      getRootPaths: vi.fn().mockResolvedValue(['/project']),
      listFiles: vi.fn().mockResolvedValue({
        entries: sampleFiles,
        truncated: false,
      }),
      logger: mockLogger,
    };
  });

  describe('createQueryFileTreeTool', () => {
    it('has correct tool ID', () => {
      const tool = createQueryFileTreeTool(deps);
      expect(tool.id).toBe(QUERY_FILE_TREE_TOOL_ID);
      expect(tool.id).toBe('brainstrike.queryFileTree');
    });

    it('queries file tree with default options', async () => {
      const tool = createQueryFileTreeTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.entries).toHaveLength(3);
      expect(result.count).toBe(3);
      expect(result.path).toBe('');
      expect(result.pattern).toBeNull();
      expect(result.truncated).toBe(false);
      expect(result.summary).toContain('2 files');
      expect(result.summary).toContain('1 directories');
    });

    it('queries specific path', async () => {
      const tool = createQueryFileTreeTool(deps);
      await tool.execute({ context: { path: '/project/src' } });

      expect(deps.listFiles).toHaveBeenCalledWith(
        '/project/src',
        expect.objectContaining({
          includeHidden: false,
          maxDepth: 3,
        })
      );
    });

    it('filters by glob pattern', async () => {
      const tool = createQueryFileTreeTool(deps);
      await tool.execute({ context: { pattern: '*.ts' } });

      expect(deps.listFiles).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          pattern: '*.ts',
        })
      );
    });

    it('respects maxDepth option', async () => {
      const tool = createQueryFileTreeTool(deps);
      await tool.execute({ context: { maxDepth: 5 } });

      expect(deps.listFiles).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          maxDepth: 5,
        })
      );
    });

    it('includes hidden files when requested', async () => {
      const tool = createQueryFileTreeTool(deps);
      await tool.execute({ context: { includeHidden: true } });

      expect(deps.listFiles).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          includeHidden: true,
        })
      );
    });

    it('indicates when results are truncated', async () => {
      deps.listFiles = vi.fn().mockResolvedValue({
        entries: sampleFiles,
        truncated: true,
      });

      const tool = createQueryFileTreeTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.truncated).toBe(true);
      expect(result.summary).toContain('truncated');
    });

    it('handles empty results', async () => {
      deps.listFiles = vi.fn().mockResolvedValue({
        entries: [],
        truncated: false,
      });

      const tool = createQueryFileTreeTool(deps);
      const result = await tool.execute({ context: { path: '/empty' } });

      expect(result.entries).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('throws safe error on failure', async () => {
      deps.listFiles = vi.fn().mockRejectedValue(new Error('IO error'));
      const tool = createQueryFileTreeTool(deps);

      await expect(tool.execute({ context: {} })).rejects.toThrow(
        FILE_TREE_ERROR_MESSAGES.queryFailed
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('logs debug messages', async () => {
      const tool = createQueryFileTreeTool(deps);
      await tool.execute({ context: { path: '/test', pattern: '*.js' } });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Querying file tree',
        expect.objectContaining({
          path: '/test',
          pattern: '*.js',
        })
      );
    });

    it('generates summary with path info', async () => {
      const tool = createQueryFileTreeTool(deps);
      const result = await tool.execute({ context: { path: '/project/src' } });

      expect(result.summary).toContain('Path: /project/src');
    });

    it('generates summary with pattern info', async () => {
      const tool = createQueryFileTreeTool(deps);
      const result = await tool.execute({ context: { pattern: '*.ts' } });

      expect(result.summary).toContain('Pattern: *.ts');
    });
  });
});
