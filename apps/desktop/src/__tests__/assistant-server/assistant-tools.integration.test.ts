import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_TOOL_DEFAULTS,
  type RuntimeData,
  resetFileReadState,
  withFileLock,
} from '@brainstrike/agent';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { disposeLspServers } from '../../assistant-server/lsp-diagnostics';
import {
  assignWindowRole,
  clearWindowRoleByWebContentsId,
  type DesktopWindowRole,
} from '../../window-role';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
  };
});

const {
  getDatabaseMock,
  getAllWindowsMock,
  invalidateManagedCacheMock,
  loggerErrorMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  invalidateManagedCacheMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

// Keep the real @brainstrike/db exports (EmbeddingSetsRepository, etc.) but stub
// the index-invalidation seam so delete/rename tests assert this tool's honest
// indexInvalidated reporting without emulating the invalidator's internals.
vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    invalidateManagedCacheEntriesByIdentity: invalidateManagedCacheMock,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      info: vi.fn(),
      warn: loggerWarnMock,
    })),
  };
});

describe('assistant-tools', () => {
  const trackedWindowIds: number[] = [];

  function createMockWindow({
    destroyed = false,
    id,
    role,
    send,
  }: {
    destroyed?: boolean;
    id: number;
    role: DesktopWindowRole;
    send: ReturnType<typeof vi.fn>;
  }): BrowserWindow {
    const browserWindow = {
      isDestroyed: () => destroyed,
      once: vi.fn(),
      webContents: { id, send },
    } as unknown as BrowserWindow;
    assignWindowRole(browserWindow, role);
    trackedWindowIds.push(id);
    return browserWindow;
  }

  async function createWorkspaceFixture(): Promise<string> {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-agent-tools-'));
    await fsPromises.mkdir(path.join(root, 'src', 'components'), { recursive: true });
    await fsPromises.mkdir(path.join(root, 'src', 'lib'), { recursive: true });
    await fsPromises.writeFile(path.join(root, 'README.md'), '# Test Workspace\n', 'utf8');
    await fsPromises.writeFile(
      path.join(root, 'src', 'main.ts'),
      'line 1\nline 2\nline 3\nline 4',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(root, 'src', 'components', 'button.tsx'),
      'export const Button = () => null;\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(root, 'src', 'lib', 'math.ts'),
      'export const add = () => 1;\n',
      'utf8'
    );
    return root;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const id of trackedWindowIds) {
      clearWindowRoleByWebContentsId(id);
    }
    trackedWindowIds.length = 0;
  });

  it('reads a workspace file with line range and truncation metadata', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceFile'];

    const result = await tool.execute({
      context: {
        endLine: 4,
        maxChars: 12,
        path: '/src/main.ts',
        startLine: 2,
      },
    });

    expect(result.path).toBe('/src/main.ts');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(4);
    expect(result.totalLines).toBe(4);
    expect(result.content).toBe('line 2\nline ');
    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBeGreaterThan(0);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('reads a workspace file when execute receives direct args', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceFile'];

    const result = await tool.execute({
      endLine: 2,
      maxChars: 50,
      path: '/src/main.ts',
      startLine: 1,
    });

    expect(result.path).toBe('/src/main.ts');
    expect(result.content).toContain('line 1');
    expect(result.truncated).toBe(false);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('rejects symlink escapes outside the workspace root', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const outsideRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-agent-outside-')
    );
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const linkedFile = path.join(workspaceRootPath, 'src', 'escape.txt');
    await fsPromises.writeFile(outsideFile, 'outside', 'utf8');

    try {
      try {
        await fsPromises.symlink(outsideFile, linkedFile, 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') {
          return;
        }
        throw error;
      }

      const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
      const tool = tools['brainstrike.readWorkspaceFile'];

      await expect(
        tool.execute({
          path: '/src/escape.txt',
        })
      ).rejects.toThrow('is outside the selected workspace root');
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      await fsPromises.rm(outsideRoot, { force: true, recursive: true });
    }
  });

  it('reads a workspace directory in compact form', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const result = await tool.execute({
      context: {
        depth: 2,
        includeDirectories: true,
        includeFiles: true,
        maxEntries: 10,
        path: '/src',
      },
    });

    expect(result.path).toBe('/src');
    expect(result.count).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.path === '/src/components')).toBe(true);
    expect(result.entries.some((entry) => entry.path === '/src/main.ts')).toBe(true);
    expect(result.truncated).toBe(false);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('lists the workspace root for path "." (regression: "." was treated as a hidden segment)', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const result = await tool.execute({
      context: {
        depth: 5,
        includeDirectories: true,
        includeFiles: true,
        maxEntries: 150,
        path: '.',
      },
    });

    // "." normalizes to the root, so entries are listed (previously came back empty
    // because the "." segment made isHiddenPath() reject everything).
    expect(result.path).toBe('/');
    expect(result.count).toBeGreaterThan(0);
    expect(result.totalMatchedFiles).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.path === '/README.md')).toBe(true);
    expect(result.entries.some((entry) => entry.path === '/src')).toBe(true);
    expect(result.entries.some((entry) => entry.path === '/src/main.ts')).toBe(true);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('reads a workspace directory when execute receives direct args', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const result = await tool.execute({
      depth: 2,
      includeDirectories: true,
      includeFiles: true,
      includeHidden: false,
      maxEntries: 10,
      path: '/src',
    });

    expect(result.path).toBe('/src');
    expect(result.entries.some((entry) => entry.path === '/src/main.ts')).toBe(true);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('returns concise entries by default and metadata only with detail: true', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const concise = await tool.execute({ path: '/src' });
    const conciseFile = concise.entries.find((entry) => entry.type === 'file');
    expect(conciseFile).toBeDefined();
    expect(conciseFile).not.toHaveProperty('size');
    expect(conciseFile).not.toHaveProperty('depth');

    const detailed = await tool.execute({ detail: true, path: '/src' });
    const detailedFile = detailed.entries.find((entry) => entry.type === 'file');
    expect(detailedFile).toHaveProperty('size');
    expect(detailedFile).toHaveProperty('depth');

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('pages directory entries with offset and emits a continuation hint when truncated', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const firstPage = await tool.execute({ maxEntries: 2, path: '/src' });
    expect(firstPage.entries.length).toBe(2);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.hint).toContain('offset: 2');

    const secondPage = await tool.execute({ maxEntries: 2, offset: 2, path: '/src' });
    expect(secondPage.offset).toBe(2);
    expect(secondPage.entries.length).toBeGreaterThan(0);
    expect(secondPage.entries[0]?.path).not.toBe(firstPage.entries[0]?.path);

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('exposes tool-only context tools and omits legacy context mutation tools from chat runtime', () => {
    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    expect(tools['brainstrike.listWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.readWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.listEmbeddingSpaces']).toBeDefined();
    expect(tools['brainstrike.queryEmbeddingSpace']).toBeDefined();
    expect(tools['brainstrike.hybridSearch']).toBeDefined();
    expect(tools['brainstrike.updateWorkspaceContextSelection']).toBeDefined();
    expect(tools['brainstrike.updateWorkspaceTapestrySelections']).toBeDefined();
    expect(tools['brainstrike.selectRootTreeFiles']).toBeUndefined();
    expect(tools['brainstrike.updatePreviewContextFiles']).toBeUndefined();
  });

  it('executes the grepSearch tool end-to-end with context-wrapped input', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', path: 'src/x.ts', start_line: 10 }],
    });
    getDatabaseMock.mockResolvedValue({ query: queryMock });

    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    const result = await tools['brainstrike.grepSearch'].execute({
      context: { outputMode: 'content', pattern: 'needle' },
    });

    // The internal chunk-locator fields (chunkId/chunkStartLine/chunkEndLine) are
    // stripped from the model-facing output to save tokens.
    expect(result.matches).toEqual([
      {
        after: ['omega'],
        before: ['alpha'],
        line: 11,
        lineText: 'needle line',
        path: 'src/x.ts',
        // The root '/tmp/workspace' is not on disk, so the live pass is skipped
        // and the hybrid result is index-only.
        source: 'index',
      },
    ]);
  });

  it('executes the grepSearch tool in default files mode with context-wrapped input', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', path: 'src/x.ts', start_line: 10 }],
    });
    getDatabaseMock.mockResolvedValue({ query: queryMock });

    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    const result = await tools['brainstrike.grepSearch'].execute({
      context: { pattern: 'needle' },
    });

    expect(result.outputMode).toBe('files');
    expect(result.files).toEqual([
      { firstLine: 11, matchCount: 1, path: 'src/x.ts', source: 'index' },
    ]);
  });

  it('rethrows sanitized grepSearch errors from the execute wrapper', async () => {
    const queryMock = vi.fn().mockRejectedValue(new Error('relation "file_chunks" does not exist'));
    getDatabaseMock.mockResolvedValue({ query: queryMock });

    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    const promise = tools['brainstrike.grepSearch'].execute({
      context: { pattern: 'needle' },
    });
    await expect(promise).rejects.toThrow(/Unable to perform grep search/);
    await expect(promise).rejects.not.toThrow(/file_chunks/);
  });

  it('filters native tools to the enabled runtime tool ids when provided', () => {
    const tools = buildDesktopAssistantTools({
      enabledNativeToolIds: ['brainstrike.listWorkspaceContext'],
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    expect(tools['brainstrike.listWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.readWorkspaceFile']).toBeUndefined();
    expect(tools['brainstrike.queryEmbeddingSpace']).toBeUndefined();
  });

  it('lists selected workspace context without returning file contents', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts', '/README.md'],
      selectionFolderId: 'root-1',
      workspaceIndexEmbeddingSetId: 'set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
      workspaceRootPath,
    } as RuntimeData);
    const tool = tools['brainstrike.listWorkspaceContext'];

    const result = await tool.execute({ context: {} });

    expect(result.workspaceRootPath).toBe(workspaceRootPath);
    expect(result.selectionFolderId).toBe('root-1');
    expect(result.selectedFileCount).toBe(2);
    expect(result.selectedFiles).toEqual(['/src/main.ts', '/README.md']);
    expect(result.workspaceIndex).toEqual({
      embeddingSetId: 'set-1',
      enabled: true,
      mode: 'root-folder-cache',
      paused: false,
    });
    expect(JSON.stringify(result)).not.toContain('line 1');
    expect(JSON.stringify(result)).not.toContain('# Test Workspace');
    // Single-root: no other-roots count key at all.
    expect(result).not.toHaveProperty('selectedFilesOutsideWorkspace');
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('reports selected files living in OTHER workspace roots (multi-root forest)', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts'],
      // Multi-root: 4 selected files belong to roots the single-root toolset
      // cannot address — the count must be SURFACED, never silently dropped.
      selectionFilePathsFromOtherRoots: 4,
      selectionFolderId: 'root-1',
      workspaceIndexingEnabled: false,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.listWorkspaceContext'].execute({ context: {} });

    expect(result.selectedFileCount).toBe(1);
    expect(result.selectedFilesOutsideWorkspace).toBe(4);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('lists every open workspace root so the model can qualify the other tools', async () => {
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: [],
      workspaceIndexingEnabled: false,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
      workspaceRoots: [
        { displayName: 'ProjectA', path: '/work/ProjectA', rootId: 'id-a' },
        { displayName: 'ProjectB', path: '/work/ProjectB', rootId: 'id-b' },
      ],
    } as unknown as RuntimeData);

    const result = await tools['brainstrike.listWorkspaceContext'].execute({ context: {} });

    expect(result.workspaceRoots).toEqual([
      { displayName: 'ProjectA', path: '/work/ProjectA', rootId: 'id-a' },
      { displayName: 'ProjectB', path: '/work/ProjectB', rootId: 'id-b' },
    ]);
  });

  it('synthesizes a single-root list from the legacy workspaceRootPath', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const result = await buildDesktopAssistantTools({
      selectionFilePaths: [],
      workspaceIndexingEnabled: false,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
      workspaceRootPath,
    } as RuntimeData)['brainstrike.listWorkspaceContext'].execute({ context: {} });

    expect(result.workspaceRoots).toHaveLength(1);
    expect(result.workspaceRoots[0]?.path).toBe(workspaceRootPath);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('lists token-aware curated workspace context metadata without file contents', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts', '/README.md'],
      selectionFolderId: 'root-1',
      workspaceContext: {
        files: [
          {
            approxTokens: 200,
            outputApproxTokens: 100,
            path: '/src/main.ts',
            ranges: [{ approxTokens: 20, endLine: 3, isActive: true, startLine: 2 }],
          },
          { approxTokens: 40, outputApproxTokens: 40, path: '/README.md', ranges: [] },
        ],
        includeProjectTree: false,
        projectTreeApproxTokens: 1800,
        projectTreeTokenCountLoading: false,
        selectedOutputApproxTokens: 140,
        selectedSourceApproxTokens: 240,
        tokenBudget: 8192,
      },
      workspaceRootPath,
    } as RuntimeData);

    const conciseResult = await tools['brainstrike.listWorkspaceContext'].execute({
      context: { includeTokenEstimates: true },
    });

    // Concise default: counts and token budgets only, no per-file range metadata.
    expect(conciseResult.curatedContext).toBeUndefined();
    expect(conciseResult.curatedContextSummary).toEqual({
      fileCount: 2,
      includeProjectTree: false,
      projectTreeApproxTokens: 1800,
      rangeCount: 1,
      selectedOutputApproxTokens: 140,
      selectedSourceApproxTokens: 240,
      tokenBudget: 8192,
    });
    expect(conciseResult.curatedContextSummary).not.toHaveProperty('useTapestryRanges');
    expect(conciseResult.truncated).toBe(false);

    const result = await tools['brainstrike.listWorkspaceContext'].execute({
      context: { detail: true, includeTokenEstimates: true },
    });

    expect(result.curatedContext).toEqual({
      files: [
        {
          approxTokens: 200,
          outputApproxTokens: 100,
          path: '/src/main.ts',
          ranges: [{ approxTokens: 20, endLine: 3, isActive: true, startLine: 2 }],
        },
        { approxTokens: 40, outputApproxTokens: 40, path: '/README.md', ranges: [] },
      ],
      includeProjectTree: false,
      projectTreeApproxTokens: 1800,
      projectTreeTokenCountLoading: false,
      selectedOutputApproxTokens: 140,
      selectedSourceApproxTokens: 240,
      tokenBudget: 8192,
    });
    expect(result.tokenEstimates).toEqual([
      { approxTokens: 200, path: '/src/main.ts' },
      { approxTokens: 40, path: '/README.md' },
    ]);
    expect(JSON.stringify(result)).not.toContain('line 1');
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('bounds huge selected-file listings with offset paging and a hint', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const selectionFilePaths = Array.from(
      { length: 2000 },
      (_, i) => `/packages/some-package/src/deeply/nested/dir-${i}/file-with-a-long-name-${i}.ts`
    );
    const tools = buildDesktopAssistantTools({
      selectionFilePaths,
      workspaceRootPath,
    } as RuntimeData);
    const tool = tools['brainstrike.listWorkspaceContext'];

    const firstPage = await tool.execute({ context: {} });
    expect(firstPage.selectedFileCount).toBe(2000);
    expect(firstPage.selectedFiles.length).toBeLessThan(2000);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.hint).toContain('offset:');
    expect(JSON.stringify(firstPage).length).toBeLessThanOrEqual(11_000);

    const secondPage = await tool.execute({
      context: { offset: firstPage.selectedFiles.length },
    });
    expect(secondPage.offset).toBe(firstPage.selectedFiles.length);
    expect(secondPage.selectedFiles[0]).not.toBe(firstPage.selectedFiles[0]);

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('reads selected workspace context under file and token limits with explicit skips', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts', '/README.md'],
      workspaceRootPath,
    } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceContext'];

    const result = await tool.execute({
      context: {
        maxCharsPerFile: 20,
        maxFiles: 1,
        tokenBudget: 100,
      },
    });

    expect(result.includedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.files[0]?.path).toBe('/src/main.ts');
    expect(result.files[0]?.content).toContain('line 1');
    expect(result.files[0]?.approxTokens).toBeGreaterThan(0);
    expect(result.skippedFiles[0]).toMatchObject({
      path: '/README.md',
      reason: 'maxFiles',
    });
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('does not expose raw filesystem errors for skipped workspace context files', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/missing.ts'],
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.readWorkspaceContext'].execute({ context: {} });

    expect(result.skippedFiles).toEqual([{ path: '/missing.ts', reason: 'missing' }]);
    expect(JSON.stringify(result.skippedFiles)).not.toContain(workspaceRootPath);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('logs generic workspace context read errors without exposing them in skipped files', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const readError = Object.assign(
      new Error(`EACCES: permission denied, open '${path.join(workspaceRootPath, 'src/main.ts')}'`),
      { code: 'EACCES' }
    );
    const readFileSpy = vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(readError);
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts'],
      workspaceRootPath,
    } as RuntimeData);

    try {
      const result = await tools['brainstrike.readWorkspaceContext'].execute({ context: {} });

      expect(result.skippedFiles).toEqual([{ path: '/src/main.ts', reason: 'readError' }]);
      expect(JSON.stringify(result.skippedFiles)).not.toContain(workspaceRootPath);
      expect(loggerWarnMock).toHaveBeenCalledWith('Skipped workspace context file read', {
        code: 'EACCES',
        error: {
          code: 'EACCES',
          name: 'Error',
          redacted: true,
        },
        path: { redacted: true },
      });
      expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain('/src/main.ts');
      expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain(workspaceRootPath);
    } finally {
      readFileSpy.mockRestore();
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('reads a rangeless (empty ranges) context file as a bare whole-file read', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        files: [
          {
            path: '/src/main.ts',
            ranges: [],
          },
        ],
      },
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.readWorkspaceContext'].execute({
      context: {
        maxCharsPerFile: 200,
        tokenBudget: 100,
        useTapestrySelections: true,
      },
    });

    expect(result.includedCount).toBe(1);
    expect(result.files[0]).not.toHaveProperty('tapestryRangeCount');
    expect(result.files[0]?.content).toContain('line 1');
    expect(result.files[0]?.content).toContain('line 2');
    expect(result.files[0]?.content).toContain('line 3');
    expect(result.files[0]?.content).toContain('line 4');
    expect(result.files[0]?.content).not.toContain('<selection');
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('reads selected workspace context through curated tapestry line ranges', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        files: [
          {
            path: '/src/main.ts',
            ranges: [{ endLine: 3, isActive: true, startLine: 2 }],
          },
        ],
      },
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.readWorkspaceContext'].execute({
      context: {
        maxCharsPerFile: 200,
        tokenBudget: 100,
        useTapestrySelections: true,
      },
    });

    expect(result.includedCount).toBe(1);
    expect(result.files[0]).toMatchObject({
      endLine: 3,
      path: '/src/main.ts',
      startLine: 2,
      tapestryRangeCount: 1,
    });
    expect(result.files[0]?.content).toContain('line 2');
    expect(result.files[0]?.content).toContain('line 3');
    expect(result.files[0]?.content).not.toContain('line 1');
    expect(result.files[0]?.content).not.toContain('line 4');
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('stops tapestry range output when range budget is exhausted', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        files: [
          {
            path: '/src/main.ts',
            ranges: [
              { endLine: 2, isActive: true, startLine: 2 },
              { endLine: 3, isActive: true, startLine: 3 },
            ],
          },
        ],
      },
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.readWorkspaceContext'].execute({
      context: {
        maxCharsPerFile: 6,
        tokenBudget: 100,
        useTapestrySelections: true,
      },
    });

    expect(result.files[0]?.content).toContain('<selection index="1"');
    expect(result.files[0]?.content).not.toContain('<selection index="2"');
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.files[0]?.omittedChars).toBeGreaterThan(0);
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('escapes selection boundary tags inside tapestry range content', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'main.ts'),
      'line 1\nliteral <selection index="1"> and <selection/> and </selection> tags with <selectionMode>\nline 3',
      'utf8'
    );
    const tools = buildDesktopAssistantTools({
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        files: [
          {
            path: '/src/main.ts',
            ranges: [{ endLine: 2, isActive: true, startLine: 2 }],
          },
        ],
      },
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.readWorkspaceContext'].execute({
      context: {
        maxCharsPerFile: 200,
        tokenBudget: 100,
        useTapestrySelections: true,
      },
    });

    expect(result.files[0]?.content).toContain(
      'literal &lt;selection index="1"> and &lt;selection/> and &lt;/selection&gt; tags'
    );
    expect(result.files[0]?.content).toContain('<selectionMode>');
    expect(result.files[0]?.content).not.toContain('literal <selection index="1">');
    expect(result.files[0]?.content).not.toContain('literal <selection/>');
    expect(result.files[0]?.content).not.toContain('literal </selection> tag');
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  describe('readWorkspaceContext multi-root', () => {
    async function createTwoRootContext(): Promise<{
      rootA: string;
      rootB: string;
      cleanup: () => Promise<void>;
    }> {
      const rootA = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-rc-a-'));
      const rootB = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-rc-b-'));
      await fsPromises.writeFile(path.join(rootA, 'notes.md'), 'notes from alpha root', 'utf8');
      await fsPromises.writeFile(path.join(rootB, 'notes.md'), 'notes from beta root', 'utf8');
      return {
        cleanup: async () => {
          await fsPromises.rm(rootA, { force: true, recursive: true });
          await fsPromises.rm(rootB, { force: true, recursive: true });
        },
        rootA,
        rootB,
      };
    }

    function twoRootRuntime(rootA: string, rootB: string): RuntimeData {
      return {
        workspaceRoots: [
          { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
          { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
        ],
      } as unknown as RuntimeData;
    }

    it('reads from the root named by `root` (with explicit filePaths) and labels the result', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        const tools = buildDesktopAssistantTools(twoRootRuntime(rootA, rootB));
        const result = await tools['brainstrike.readWorkspaceContext'].execute({
          context: { filePaths: ['/notes.md'], root: 'ProjectB' },
        });
        expect(result.rootName).toBe('ProjectB');
        expect(result.rootId).toBe('id-b');
        expect(result.files[0]?.content).toContain('beta root');
      } finally {
        await cleanup();
      }
    });

    it('resolves `root` by id as well as by display name', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        const result = await buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
          'brainstrike.readWorkspaceContext'
        ].execute({ context: { filePaths: ['/notes.md'], root: 'id-a' } });
        expect(result.rootName).toBe('ProjectA');
        expect(result.files[0]?.content).toContain('alpha root');
      } finally {
        await cleanup();
      }
    });

    it('errors and lists the open folders when `root` is omitted and several are open', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        await expect(
          buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
            'brainstrike.readWorkspaceContext'
          ].execute({ context: { filePaths: ['/notes.md'] } })
        ).rejects.toThrow(/multiple folders.*ProjectA.*ProjectB/is);
      } finally {
        await cleanup();
      }
    });

    it('errors with the available folders for an unknown `root`', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        await expect(
          buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
            'brainstrike.readWorkspaceContext'
          ].execute({ context: { filePaths: ['/notes.md'], root: 'Nope' } })
        ).rejects.toThrow(/no folder "Nope".*ProjectA.*ProjectB/is);
      } finally {
        await cleanup();
      }
    });

    it('requires explicit filePaths when `root` is provided (selection defaults are focused-root only)', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        await expect(
          buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
            'brainstrike.readWorkspaceContext'
          ].execute({ context: { root: 'ProjectA' } })
        ).rejects.toThrow(/filePaths/i);
      } finally {
        await cleanup();
      }
    });

    it('still reads the focused-root selection default (single root) and labels the result', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const result = await buildDesktopAssistantTools({
          selectionFilePaths: ['/src/main.ts'],
          workspaceRootPath,
        } as RuntimeData)['brainstrike.readWorkspaceContext'].execute({ context: {} });
        expect(result.includedCount).toBe(1);
        expect(result.files[0]?.path).toBe('/src/main.ts');
        expect(typeof result.rootName).toBe('string');
        expect(result.workspaceRootPath).toBe(workspaceRootPath);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });
  });

  it('broadcasts bulk workspace context selection updates with explicit skip metadata', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const send = vi.fn();
    const hiddenSend = vi.fn();
    getAllWindowsMock.mockReturnValue([
      createMockWindow({ id: 1001, role: 'visible-ui', send }),
      createMockWindow({ id: 1002, role: 'embedding-host', send: hiddenSend }),
      createMockWindow({ destroyed: true, id: 1003, role: 'visible-ui', send: vi.fn() }),
    ]);
    const tools = buildDesktopAssistantTools({
      selectionFolderId: 'root-1',
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.updateWorkspaceContextSelection'].execute({
      context: {
        filePaths: ['/src/main.ts', '/missing.ts'],
        mode: 'replace',
      },
    });

    expect(result).toMatchObject({
      appliedCount: 1,
      folderId: 'root-1',
      mode: 'replace',
      notifiedWindowCount: 1,
      requestedCount: 2,
      selectedFiles: ['/src/main.ts'],
      skippedCount: 1,
      skippedFiles: [{ path: '/missing.ts', reason: 'missing' }],
    });
    expect(result.skippedFiles[0]).not.toHaveProperty('message');
    expect(JSON.stringify(result.skippedFiles)).not.toContain(workspaceRootPath);
    expect(send).toHaveBeenCalledWith('assistant:workspace-context-selection-update', {
      filePaths: ['/src/main.ts'],
      folderId: 'root-1',
      mode: 'replace',
    });
    expect(hiddenSend).not.toHaveBeenCalled();
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  describe('selection write-back multi-root routing', () => {
    function routingRuntime(rootA: string, rootB: string): RuntimeData {
      return {
        selectionFolderId: 'client-a',
        workspaceRootPath: rootA,
        workspaceRoots: [
          { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
          { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
        ],
      } as unknown as RuntimeData;
    }

    it('routes a selection update to a NON-focused root, broadcasting its rootPath', async () => {
      const rootA = await createWorkspaceFixture();
      const rootB = await createWorkspaceFixture();
      const send = vi.fn();
      getAllWindowsMock.mockReturnValue([createMockWindow({ id: 2001, role: 'visible-ui', send })]);
      try {
        // ProjectA is focused; the model targets ProjectB. The file is validated
        // against ProjectB's real path and the broadcast carries rootPath so the
        // renderer can route to the matching client folder.
        const result = await buildDesktopAssistantTools(routingRuntime(rootA, rootB))[
          'brainstrike.updateWorkspaceContextSelection'
        ].execute({ context: { filePaths: ['/src/main.ts'], mode: 'replace', root: 'ProjectB' } });
        expect(result.appliedCount).toBe(1);
        expect(send).toHaveBeenCalledWith(
          'assistant:workspace-context-selection-update',
          expect.objectContaining({ mode: 'replace', rootId: 'id-b', rootPath: rootB })
        );
      } finally {
        await fsPromises.rm(rootA, { force: true, recursive: true });
        await fsPromises.rm(rootB, { force: true, recursive: true });
      }
    });

    it('omits rootPath for the legacy single/focused-root path (renderer routes by folderId)', async () => {
      const rootA = await createWorkspaceFixture();
      const send = vi.fn();
      getAllWindowsMock.mockReturnValue([createMockWindow({ id: 2002, role: 'visible-ui', send })]);
      try {
        await buildDesktopAssistantTools({
          selectionFolderId: 'client-a',
          workspaceRootPath: rootA,
        } as RuntimeData)['brainstrike.updateWorkspaceContextSelection'].execute({
          context: { filePaths: ['/src/main.ts'], mode: 'replace' },
        });
        const payload = send.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
        expect(payload).toMatchObject({ folderId: 'client-a' });
        expect(payload).not.toHaveProperty('rootPath');
      } finally {
        await fsPromises.rm(rootA, { force: true, recursive: true });
      }
    });

    it('still throws on an unknown root qualifier (no broadcast)', async () => {
      const rootA = await createWorkspaceFixture();
      const rootB = await createWorkspaceFixture();
      const send = vi.fn();
      getAllWindowsMock.mockReturnValue([createMockWindow({ id: 2003, role: 'visible-ui', send })]);
      try {
        await expect(
          buildDesktopAssistantTools(routingRuntime(rootA, rootB))[
            'brainstrike.updateWorkspaceContextSelection'
          ].execute({ context: { filePaths: ['/src/main.ts'], root: 'Nope' } })
        ).rejects.toThrow(/no folder "Nope"/i);
        expect(send).not.toHaveBeenCalled();
      } finally {
        await fsPromises.rm(rootA, { force: true, recursive: true });
        await fsPromises.rm(rootB, { force: true, recursive: true });
      }
    });

    it('routes a tapestry update to a non-focused root, broadcasting its rootPath', async () => {
      const rootA = await createWorkspaceFixture();
      const rootB = await createWorkspaceFixture();
      const send = vi.fn();
      getAllWindowsMock.mockReturnValue([createMockWindow({ id: 2004, role: 'visible-ui', send })]);
      try {
        await buildDesktopAssistantTools(routingRuntime(rootA, rootB))[
          'brainstrike.updateWorkspaceTapestrySelections'
        ].execute({
          context: {
            root: 'ProjectB',
            updates: [{ path: '/src/main.ts', ranges: [{ endLine: 2, startLine: 1 }] }],
          },
        });
        expect(send).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ rootId: 'id-b', rootPath: rootB })
        );
      } finally {
        await fsPromises.rm(rootA, { force: true, recursive: true });
        await fsPromises.rm(rootB, { force: true, recursive: true });
      }
    });
  });

  it('broadcasts workspace tapestry range updates and can select the affected files first', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const send = vi.fn();
    const hiddenSend = vi.fn();
    getAllWindowsMock.mockReturnValue([
      createMockWindow({ id: 1101, role: 'visible-ui', send }),
      createMockWindow({ id: 1102, role: 'llm-host', send: hiddenSend }),
    ]);
    const tools = buildDesktopAssistantTools({
      selectionFolderId: 'root-1',
      workspaceRootPath,
    } as RuntimeData);

    const result = await tools['brainstrike.updateWorkspaceTapestrySelections'].execute({
      context: {
        mode: 'replace',
        selectFiles: true,
        updates: [
          {
            path: '/src/main.ts',
            ranges: [{ endLine: 3, isActive: true, startLine: 2 }],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      appliedFileCount: 1,
      folderId: 'root-1',
      mode: 'replace',
      notifiedWindowCount: 1,
      requestedFileCount: 1,
      skippedFileCount: 0,
    });
    expect(send).toHaveBeenNthCalledWith(1, 'assistant:workspace-context-selection-update', {
      filePaths: ['/src/main.ts'],
      folderId: 'root-1',
      mode: 'add',
    });
    expect(send).toHaveBeenNthCalledWith(2, 'assistant:workspace-context-tapestry-update', {
      folderId: 'root-1',
      mode: 'replace',
      updates: [
        {
          path: '/src/main.ts',
          ranges: [{ endLine: 3, isActive: true, startLine: 2 }],
        },
      ],
    });
    expect(hiddenSend).not.toHaveBeenCalled();
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('lists embedding spaces with optional coverage stats', async () => {
    getDatabaseMock.mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                averageTokensPerChunk: '10',
                createdAt: '2026-01-01T00:00:00.000Z',
                description: null,
                dimensions: 1536,
                distance: 'cosine',
                embeddedChunks: '3',
                fileCount: '2',
                id: 'set-1',
                modelId: 'text-embedding-3-small',
                modelKey: 'openai:text-embedding-3-small',
                name: 'Main',
                tokenizedChunkCount: '4',
                totalChunks: '5',
                totalTokens: '40',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    });
    const tools = buildDesktopAssistantTools({
      workspaceIndexEmbeddingSetId: 'set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
    } as RuntimeData);
    const tool = tools['brainstrike.listEmbeddingSpaces'];

    const result = await tool.execute({ context: { includeStats: true } });

    expect(result.count).toBe(1);
    expect(result.workspaceIndex).toEqual({
      embeddingSetId: 'set-1',
      enabled: true,
      mode: 'root-folder-cache',
      paused: false,
    });
    expect(result.spaces[0]).toMatchObject({
      coverage: {
        averageTokensPerChunk: 10,
        coveragePercent: 60,
        embeddedChunks: 3,
        fileCount: 2,
        tokenizedChunkCount: 4,
        totalChunks: 5,
        totalTokens: 40,
      },
      dimensions: 1536,
      distance: 'cosine',
      id: 'set-1',
      isWorkspaceIndex: true,
      modelId: 'text-embedding-3-small',
      modelKey: 'openai:text-embedding-3-small',
      name: 'Main',
      recommendedForWorkspaceSearch: true,
    });
  });

  it('preserves nullable embedding space names in tool output', async () => {
    getDatabaseMock.mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                createdAt: '2026-01-01T00:00:00.000Z',
                description: null,
                dimensions: 384,
                distance: 'cosine',
                id: 'set-1',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                modelKey: 'local:Xenova/all-MiniLM-L6-v2',
                name: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    });
    const tools = buildDesktopAssistantTools(undefined);
    const tool = tools['brainstrike.listEmbeddingSpaces'];

    const result = await tool.execute({ context: {} });

    expect(result.spaces).toEqual([
      expect.objectContaining({
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'set-1',
        name: null,
      }),
    ]);
  });

  it('can narrow embedding spaces to the configured workspace index', async () => {
    getDatabaseMock.mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                createdAt: '2026-01-02T00:00:00.000Z',
                description: null,
                dimensions: 1536,
                distance: 'cosine',
                id: 'set-1',
                modelId: 'text-embedding-3-small',
                modelKey: 'openai:text-embedding-3-small',
                name: 'Workspace Index',
              },
              {
                createdAt: '2026-01-01T00:00:00.000Z',
                description: null,
                dimensions: 1536,
                distance: 'cosine',
                id: 'set-2',
                modelId: 'text-embedding-3-small',
                modelKey: 'openai:text-embedding-3-small',
                name: 'Scratch',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    });
    const tools = buildDesktopAssistantTools({
      workspaceIndexEmbeddingSetId: 'set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
    } as RuntimeData);
    const tool = tools['brainstrike.listEmbeddingSpaces'];

    const result = await tool.execute({ context: { workspaceIndexOnly: true } });

    expect(result.count).toBe(1);
    expect(result.spaces).toEqual([
      expect.objectContaining({
        id: 'set-1',
        isWorkspaceIndex: true,
        recommendedForWorkspaceSearch: true,
      }),
    ]);
  });

  it('requires an explicit embedding space id for semantic context queries', async () => {
    const tools = buildDesktopAssistantTools(undefined);
    const tool = tools['brainstrike.queryEmbeddingSpace'];

    await expect(
      tool.execute({
        context: {
          query: 'where is context assembled?',
        },
      })
    ).rejects.toThrow('Select an embedding space before querying semantic context.');
  });

  it('allows semantic context queries without explicit id when the workspace index is blocked', async () => {
    const tools = buildDesktopAssistantTools({
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 0,
        pending: 0,
        processed: 0,
        totalQueued: 0,
      },
      workspaceIndexStatusState: 'blocked',
    } as RuntimeData);
    const tool = tools['brainstrike.queryEmbeddingSpace'];

    const result = await tool.execute({
      context: {
        query: 'where is context assembled?',
      },
    });

    expect(result).toMatchObject({
      reason: 'workspace-index-blocked',
      status: 'unavailable',
      workspaceIndex: {
        blockedReason: 'missing-provider-key',
        embeddingSetId: 'workspace-index-set',
      },
    });
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('rejects invalid directory payloads instead of crashing', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    await expect(
      tool.execute({
        path: null,
      } as unknown as { path: string })
    ).rejects.toThrow();

    await expect(
      tool.execute({
        context: {
          path: null,
        },
      } as unknown as { path: string })
    ).rejects.toThrow();

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('rejects binary files for text reads', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const binaryPath = path.join(workspaceRootPath, 'src', 'image.bin');
    await fsPromises.writeFile(binaryPath, Buffer.from([0, 255, 17, 23]));

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceFile'];

    await expect(
      tool.execute({
        path: '/src/image.bin',
      })
    ).rejects.toThrow('is a binary file and cannot be read as text');

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('fails explicitly when workspace root is missing for directory reads', async () => {
    const tools = buildDesktopAssistantTools(undefined);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    await expect(
      tool.execute({
        path: '/',
      })
    ).rejects.toThrow(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  });

  it('redacts native tool input and error values from failure logs', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceFile'];

    await expect(
      tool.execute({
        path: '/private/customer-secret.ts',
      })
    ).rejects.toThrow();

    expect(loggerErrorMock).toHaveBeenCalledWith('readWorkspaceFile failed', {
      error: expect.objectContaining({
        code: 'ENOENT',
        name: 'Error',
        redacted: true,
      }),
      input: {
        fields: ['path'],
        redacted: true,
      },
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('customer-secret');
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(workspaceRootPath);
  });

  it('findWorkspaceSymbol returns a precise enclosing range without whole-file content', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
      [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export const PI = 3.14;',
        '',
      ].join('\n'),
      'utf8'
    );
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.findWorkspaceSymbol'];

    const result = await tool.execute({ context: { path: '/src/lib/math.ts', query: 'add' } });
    expect(result.matches[0]).toMatchObject({ declarationLine: 1, endLine: 3, startLine: 1 });
    expect(result.path).toBe('/src/lib/math.ts');
    expect(result).not.toHaveProperty('content');

    const none = await tool.execute({ context: { path: '/src/lib/math.ts', query: 'nope' } });
    expect(none).toMatchObject({ matches: [], totalMatches: 0, truncated: false });

    await expect(
      tool.execute({ context: { path: '../outside.ts', query: 'x' } })
    ).rejects.toThrow();

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  describe('writeWorkspaceFile', () => {
    it('creates a new file (created: true) with the right content and byte count', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
        const tool = tools['brainstrike.writeWorkspaceFile'];

        const result = await tool.execute({
          context: { content: 'export const created = true;\n', path: '/src/new-file.ts' },
        });

        expect(result.path).toBe('/src/new-file.ts');
        expect(result.created).toBe(true);
        expect(result.bytesWritten).toBe(Buffer.byteLength('export const created = true;\n'));
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'new-file.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const created = true;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('creates missing parent directories', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        const result = await tool.execute({
          context: { content: 'hello', path: '/deeply/nested/dir/file.txt' },
        });

        expect(result.created).toBe(true);
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'deeply', 'nested', 'dir', 'file.txt'),
          'utf8'
        );
        expect(onDisk).toBe('hello');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('overwrites an existing file (created: false)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        const result = await tool.execute({
          context: { content: '# Overwritten\n', path: '/README.md' },
        });

        expect(result.created).toBe(false);
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# Overwritten\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects a relative "../" escape and writes no file outside the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-out-'));
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        // "../" is clamped at the root by normalizeWorkspacePath, so this normalizes
        // to "/escaped.txt" INSIDE the root — it must NOT land in the sibling dir.
        await tool.execute({ context: { content: 'nope', path: '../escaped.txt' } });

        await expect(
          fsPromises.access(path.join(path.dirname(workspaceRootPath), 'escaped.txt'))
        ).rejects.toThrow();
        await expect(fsPromises.access(path.join(outsideRoot, 'escaped.txt'))).rejects.toThrow();
        // Landed safely inside the root instead.
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'escaped.txt'),
          'utf8'
        );
        expect(onDisk).toBe('nope');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects a write through a symlinked directory that escapes the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-link-'));
      const linkDir = path.join(workspaceRootPath, 'src', 'linked');
      try {
        try {
          await fsPromises.symlink(outsideRoot, linkDir, 'dir');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'escape', path: '/src/linked/pwned.txt' } })
        ).rejects.toThrow('is outside the selected workspace root');
        // Nothing was written through the symlink into the outside dir.
        await expect(fsPromises.access(path.join(outsideRoot, 'pwned.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects a DANGLING symlink leaf that points outside the root (regression: escaped containment)', async () => {
      // The leaf is an existing symlink whose target does NOT exist. realpath(leaf)
      // throws ENOENT, so the old resolver treated it as not-yet-created and wrote
      // through the real symlink, landing bytes OUTSIDE the root. Must now throw.
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-dl-'));
      const outsideTarget = path.join(outsideRoot, 'pwned.txt'); // never created (dangling)
      const leafLink = path.join(workspaceRootPath, 'src', 'evil.txt');
      try {
        try {
          await fsPromises.symlink(outsideTarget, leafLink, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'PWNED', path: '/src/evil.txt' } })
        ).rejects.toThrow('is outside the selected workspace root');
        // The bytes never escaped through the dangling symlink.
        await expect(fsPromises.access(outsideTarget)).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects a LIVE symlink leaf that points outside the root', async () => {
      // The leaf symlink targets an EXISTING file outside the root; writeFile would
      // overwrite it. Must throw and leave the outside file untouched.
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-ll-'));
      const outsideTarget = path.join(outsideRoot, 'pwned.txt');
      const leafLink = path.join(workspaceRootPath, 'src', 'evil.txt');
      await fsPromises.writeFile(outsideTarget, 'original', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, leafLink, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'PWNED', path: '/src/evil.txt' } })
        ).rejects.toThrow('is outside the selected workspace root');
        // The outside file was NOT overwritten through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('original');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects an INTERMEDIATE dangling symlinked directory that escapes the root', async () => {
      // A parent component is a symlink to a non-existent outside dir. A plain
      // mkdir -p would create the target and write through it; must throw instead.
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-id-'));
      const outsideDir = path.join(outsideRoot, 'subdir'); // never created (dangling)
      const linkDir = path.join(workspaceRootPath, 'src', 'linkdir');
      try {
        try {
          await fsPromises.symlink(outsideDir, linkDir, 'dir');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'PWNED', path: '/src/linkdir/pwned.txt' } })
        ).rejects.toThrow('outside the selected workspace root');
        // Nothing was created under the dangling intermediate symlink.
        await expect(fsPromises.access(path.join(outsideDir, 'pwned.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects content exceeding the write byte cap with a typed error', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];
        // 2 MB + 1 byte exceeds MAX_WRITE_WORKSPACE_FILE_BYTES.
        const oversized = 'a'.repeat(2_000_001);
        await expect(
          tool.execute({ context: { content: oversized, path: '/big.txt' } })
        ).rejects.toThrow(/exceeding the .* byte write limit/i);
        // No partial/empty file was created.
        await expect(fsPromises.access(path.join(workspaceRootPath, 'big.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects writing to the workspace root itself', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];
        await expect(tool.execute({ context: { content: 'x', path: '/' } })).rejects.toThrow(
          /workspace root/i
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects overwriting a directory with file content', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];
        await expect(tool.execute({ context: { content: 'x', path: '/src' } })).rejects.toThrow(
          /is a directory/i
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('writes to the folder named by `root` in a multi-root workspace', async () => {
      const rootA = await createWorkspaceFixture();
      const rootB = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({
          workspaceRoots: [
            { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
            { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
          ],
        } as unknown as RuntimeData)['brainstrike.writeWorkspaceFile'];

        const result = await tool.execute({
          context: { content: 'into B', path: '/note.txt', root: 'ProjectB' },
        });

        expect(result.rootName).toBe('ProjectB');
        expect(await fsPromises.readFile(path.join(rootB, 'note.txt'), 'utf8')).toBe('into B');
        await expect(fsPromises.access(path.join(rootA, 'note.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(rootA, { force: true, recursive: true });
        await fsPromises.rm(rootB, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const tool = buildDesktopAssistantTools(undefined)['brainstrike.writeWorkspaceFile'];
      await expect(tool.execute({ context: { content: 'x', path: '/x.txt' } })).rejects.toThrow(
        /No folder is open/i
      );
    });
  });

  describe('stringReplaceWorkspaceFile', () => {
    it('applies an exact match and leaves the rest of the file intact', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        const result = await tool.execute({
          context: {
            newStr: 'export const add = () => 2;',
            oldStr: 'export const add = () => 1;',
            path: '/src/lib/math.ts',
          },
        });

        expect(result.replaced).toBe(true);
        expect(result.path).toBe('/src/lib/math.ts');
        expect(result.matchType).toBe('exact');
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const add = () => 2;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies a whitespace-normalized match when only indentation differs', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'ws.ts');
      // Tab indentation + extra inner spaces in the file.
      await fsPromises.writeFile(filePath, 'function f() {\n\treturn   1 ;\n}\n', 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        const result = await tool.execute({
          context: {
            newStr: '  return 2;',
            oldStr: 'return 1 ;',
            path: '/src/ws.ts',
          },
        });

        expect(result.matchType).toBe('whitespace-normalized');
        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toContain('return 2;');
        expect(onDisk).not.toContain('return   1');
        expect(onDisk.startsWith('function f() {')).toBe(true);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies a close (Levenshtein-fuzzy) multi-line match', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'cfg.ts');
      await fsPromises.writeFile(
        filePath,
        'const config = {\n  enabled: true,\n  retries: 3,\n};\n',
        'utf8'
      );
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await tool.execute({
          context: {
            newStr: 'const config = {\n  enabled: false,\n  retries: 5,\n};',
            oldStr: 'const config = {\n  enabled: true,\n  retries: 3,\n};',
            path: '/src/cfg.ts',
          },
        });

        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toContain('enabled: false');
        expect(onDisk).toContain('retries: 5');
        expect(onDisk).not.toContain('retries: 3');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS on an ambiguous single-line oldStr and writes NOTHING', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'dup.ts');
      const original = 'count++;\ndoThing();\ncount++;\ndoOther();\ncount++;\n';
      await fsPromises.writeFile(filePath, original, 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: { newStr: 'count--;', oldStr: 'count++;', path: '/src/dup.ts' },
          })
        ).rejects.toThrow(/locations|matches|surrounding/i);
        // The file is untouched — no partial / wrong-location edit.
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS on a MULTI-LINE duplicate block and rewrites NOTHING (over-broad-edit fix)', async () => {
      // Regression for the reviewer-found over-broad edit: a multi-line oldStr
      // matching N>1 locations previously rewrote EVERY block (replace-all). It
      // must now be refused, leaving the whole file byte-identical.
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'dupblock.ts');
      const block = 'if (cfg) {\n  enable();\n}';
      const original = `${block}\nmiddle();\n${block}\ntail();\n`;
      await fsPromises.writeFile(filePath, original, 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: { newStr: 'disable();', oldStr: block, path: '/src/dupblock.ts' },
          })
        ).rejects.toThrow(/2 locations|surrounding/i);
        // BOTH blocks intact — nothing was replace-all'd.
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS when oldStr is not found and writes NOTHING', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const original = await fsPromises.readFile(filePath, 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: {
              newStr: 'x',
              oldStr: 'this string is absolutely nowhere in the file content',
              path: '/src/lib/math.ts',
            },
          })
        ).rejects.toThrow(/no sufficiently close match|not\s|Re-read/i);
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('serializes two concurrent edits to the SAME file (both apply, no lost update)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      // Two distinct, non-overlapping lines so both edits target different blocks.
      await fsPromises.writeFile(filePath, 'const a = 1;\nconst b = 2;\n', 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        // Fire both at once; the per-file lock must serialize their
        // read-modify-write cycles so neither clobbers the other's edit.
        const [r1, r2] = await Promise.all([
          tool.execute({
            context: { newStr: 'const a = 10;', oldStr: 'const a = 1;', path: '/src/lib/math.ts' },
          }),
          tool.execute({
            context: { newStr: 'const b = 20;', oldStr: 'const b = 2;', path: '/src/lib/math.ts' },
          }),
        ]);

        expect(r1.replaced).toBe(true);
        expect(r2.replaced).toBe(true);
        // BOTH edits landed — a lost update would leave one original line.
        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toBe('const a = 10;\nconst b = 20;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('inherits the symlink-leaf write rejection (cannot escape via the write-back)', async () => {
      // Reuse of PR-2.1's symlink-leaf protection through the SHARED safe write:
      // a leaf symlink pointing outside the root must be refused, so the edited
      // bytes never escape. (Proves stringReplace uses the same audited write
      // path — not a weaker copy.)
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-sr-ll-'));
      const outsideTarget = path.join(outsideRoot, 'pwned.txt');
      const leafLink = path.join(workspaceRootPath, 'src', 'evil.ts');
      await fsPromises.writeFile(outsideTarget, 'original\n', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, leafLink, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        // The read side resolves the symlink and reads the outside file's content;
        // the write-back must then REFUSE the symlink leaf. Either way no bytes
        // escape through the link.
        await expect(
          tool.execute({
            context: { newStr: 'PWNED', oldStr: 'original', path: '/src/evil.ts' },
          })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // The outside file was NOT modified through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('original\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const tool = buildDesktopAssistantTools(undefined)['brainstrike.stringReplaceWorkspaceFile'];
      await expect(
        tool.execute({ context: { newStr: 'b', oldStr: 'a', path: '/x.ts' } })
      ).rejects.toThrow(/No folder is open/i);
    });
  });

  describe('read-before-write staleness guard', () => {
    const guardRuntime = (workspaceRootPath: string): RuntimeData =>
      ({
        memory: { resourceId: 'guard-resource', runId: 'guard-run', threadId: 'guard-thread' },
        workspaceRootPath,
      }) as RuntimeData;

    /** Simulate a USER edit outside the assistant tools: new bytes + a forced
     * future mtime so the compare never false-passes on coarse-mtime volumes. */
    async function externallyEdit(absolutePath: string, content: string): Promise<void> {
      await fsPromises.writeFile(absolutePath, content, 'utf8');
      const future = new Date(Date.now() + 5000);
      await fsPromises.utimes(absolutePath, future, future);
    }

    beforeEach(() => {
      resetFileReadState();
    });

    it('write refuses when the file changed on disk after the assistant read it', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });

        await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

        await expect(
          tools['brainstrike.writeWorkspaceFile'].execute({
            context: { content: '# Agent overwrite\n', path: '/README.md' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        // The user's edit survived — nothing was overwritten.
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# User edit\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('stringReplace refuses when the file changed on disk after the assistant read it', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/lib/math.ts' },
        });

        await externallyEdit(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'export const add = () => 2;\n'
        );

        await expect(
          tools['brainstrike.stringReplaceWorkspaceFile'].execute({
            context: {
              newStr: 'export const add = () => 3;',
              oldStr: 'export const add = () => 2;',
              path: '/src/lib/math.ts',
            },
          })
        ).rejects.toThrow(/changed on disk since/i);
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const add = () => 2;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('write proceeds when unchanged since read, and consecutive writes stay allowed', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });

        const first = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# First\n', path: '/README.md' },
        });
        expect(first.created).toBe(false);

        // A successful write refreshes the known state — no self-staleness.
        const second = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Second\n', path: '/README.md' },
        });
        expect(second.created).toBe(false);
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# Second\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('still allows overwriting a file this scope never observed (compare-only contract)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        const result = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Never read first\n', path: '/README.md' },
        });
        expect(result.created).toBe(false);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('a successful write establishes known state that a later external edit invalidates', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: 'const value = 1;\n', path: '/src/state.ts' },
        });

        await externallyEdit(path.join(workspaceRootPath, 'src', 'state.ts'), 'const value = 2;\n');

        await expect(
          tools['brainstrike.stringReplaceWorkspaceFile'].execute({
            context: {
              newStr: 'const value = 3;',
              oldStr: 'const value = 2;',
              path: '/src/state.ts',
            },
          })
        ).rejects.toThrow(/changed on disk since/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rename refuses when the source changed on disk after the assistant read it', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/lib/math.ts' },
        });

        await externallyEdit(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'export const add = () => 99;\n'
        );

        await expect(
          tools['brainstrike.renameWorkspaceFile'].execute({
            context: { fromPath: '/src/lib/math.ts', toPath: '/src/lib/sum.ts' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        // The move did not happen.
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src', 'lib', 'sum.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('serializes the read-and-record under the same per-file lock as writes', async () => {
      // The tracker record must be ordered against same-file writes: an
      // unlocked read could stat OLD mtime, lose the race to a locked write
      // (which records the fresh post-write mtime), then clobber the tracker
      // back to the stale value — making the NEXT legitimate write falsely
      // refuse. Proof: while the file's write lock is held, the read tool must
      // not complete.
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        const canonicalPath = realpathSync(path.join(workspaceRootPath, 'README.md'));

        let releaseLock: () => void = () => {
          throw new Error('release not armed');
        };
        const holdLock = withFileLock(
          canonicalPath,
          () =>
            new Promise<void>((resolve) => {
              releaseLock = resolve;
            })
        );

        let readSettled = false;
        const readPromise = tools['brainstrike.readWorkspaceFile']
          .execute({ context: { path: '/README.md' } })
          .finally(() => {
            readSettled = true;
          });

        // Give the (mis-ordered) read every chance to complete outside the lock.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readSettled).toBe(false);

        releaseLock();
        await holdLock;
        await readPromise;
        expect(readSettled).toBe(true);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('guards a rename whose SYMLINK source target changed since the read', async () => {
      // Reads record under the realpath'd TARGET; rename mutates the LINK
      // path. The compare must use the matching identity or a read-then-
      // externally-modified symlinked source silently skips the guard.
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      try {
        try {
          await fsPromises.symlink(targetPath, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/alias.ts' },
        });

        await externallyEdit(targetPath, 'export const add = () => 42;\n');

        await expect(
          tools['brainstrike.renameWorkspaceFile'].execute({
            context: { fromPath: '/src/alias.ts', toPath: '/src/alias-moved.ts' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        // The link did not move.
        await expect(
          fsPromises.lstat(path.join(workspaceRootPath, 'src', 'alias-moved.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('renames a read-but-unchanged symlink source without refusal', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      try {
        try {
          await fsPromises.symlink(targetPath, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/alias.ts' },
        });

        const result = await tools['brainstrike.renameWorkspaceFile'].execute({
          context: { fromPath: '/src/alias.ts', toPath: '/src/alias-moved.ts' },
        });
        expect(result.ok).toBe(true);
        const moved = await fsPromises.lstat(path.join(workspaceRootPath, 'src', 'alias-moved.ts'));
        expect(moved.isSymbolicLink()).toBe(true);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('re-reading the file clears the refusal (documented recovery path)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });
        await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

        await expect(
          tools['brainstrike.writeWorkspaceFile'].execute({
            context: { content: '# Agent v1\n', path: '/README.md' },
          })
        ).rejects.toThrow(/changed on disk since/i);

        // The actionable error tells the model to re-read; doing so recovers.
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });
        const result = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Agent v2\n', path: '/README.md' },
        });
        expect(result.created).toBe(false);
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# Agent v2\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });
  });

  describe('deleteWorkspaceFile', () => {
    it('deletes an existing file and reports indexInvalidated: false when no workspace index', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];

        const result = await tool.execute({ context: { path: '/src/lib/math.ts' } });

        expect(result).toMatchObject({
          indexInvalidated: false,
          ok: true,
          path: '/src/lib/math.ts',
        });
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src', 'lib', 'math.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('invalidates the workspace index when the file was indexed (indexInvalidated: true)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      getDatabaseMock.mockResolvedValue({ query: vi.fn(async () => ({ rows: [] })) });
      invalidateManagedCacheMock.mockResolvedValue({
        canceledEmbeddingJobCount: 1,
        deletedChunkIds: ['chunk-1'],
        deletedFileRecordIds: ['rec-1'],
      });
      try {
        const tool = buildDesktopAssistantTools({
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceRootPath,
        } as RuntimeData)['brainstrike.deleteWorkspaceFile'];

        const result = await tool.execute({ context: { path: '/src/lib/math.ts' } });

        expect(result.ok).toBe(true);
        expect(result.indexInvalidated).toBe(true);
        // The invalidation targets the root-relative path (no leading slash),
        // scoped to the configured workspace-index embedding set.
        expect(invalidateManagedCacheMock).toHaveBeenCalledWith(expect.anything(), {
          embeddingSetId: 'set-1',
          targets: [{ mode: 'exact', relativePath: 'src/lib/math.ts', rootId: workspaceRootPath }],
        });
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('throws a not-found error for a missing file', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];
        await expect(tool.execute({ context: { path: '/src/does-not-exist.ts' } })).rejects.toThrow(
          /does not exist/i
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to delete a directory (suggests executeCommand)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];
        await expect(tool.execute({ context: { path: '/src' } })).rejects.toThrow(
          /is a directory.*executeCommand/is
        );
        // The directory is untouched.
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src'))
        ).resolves.toBeUndefined();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('clamps a "../" escape to inside the root (deletes the in-root file, never the sibling)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-del-esc-'));
      const outsideFile = path.join(path.dirname(workspaceRootPath), 'escaped.txt');
      const siblingFile = path.join(outsideRoot, 'escaped.txt');
      await fsPromises.writeFile(outsideFile, 'do not delete', 'utf8');
      await fsPromises.writeFile(siblingFile, 'do not delete', 'utf8');
      // The clamped path "/escaped.txt" lives INSIDE the root.
      await fsPromises.writeFile(path.join(workspaceRootPath, 'escaped.txt'), 'in root', 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];
        const result = await tool.execute({ context: { path: '../escaped.txt' } });
        // Unrooted input keeps the relative convention; ".." is clamped so it
        // resolves to the in-root file, never the sibling dir.
        expect(result.path).toBe('escaped.txt');
        // The in-root file is gone; the two outside files are untouched.
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'escaped.txt'))
        ).rejects.toThrow();
        expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('do not delete');
        expect(await fsPromises.readFile(siblingFile, 'utf8')).toBe('do not delete');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
        await fsPromises.rm(outsideFile, { force: true });
      }
    });

    it('rejects deleting through a symlinked directory that escapes the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-del-link-'));
      const outsideTarget = path.join(outsideRoot, 'secret.txt');
      await fsPromises.writeFile(outsideTarget, 'secret', 'utf8');
      const linkDir = path.join(workspaceRootPath, 'src', 'linked');
      try {
        try {
          await fsPromises.symlink(outsideRoot, linkDir, 'dir');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];
        await expect(tool.execute({ context: { path: '/src/linked/secret.txt' } })).rejects.toThrow(
          /outside the selected workspace root/i
        );
        // The outside file was NOT deleted through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('secret');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('deletes a SYMLINK to an in-root file: the link is removed, the target is untouched', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      try {
        try {
          await fsPromises.symlink(targetPath, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];

        const result = await tool.execute({ context: { path: '/src/alias.ts' } });

        expect(result).toMatchObject({ ok: true, path: '/src/alias.ts' });
        // The LINK is gone; the target file it pointed at is intact.
        await expect(fsPromises.lstat(linkPath)).rejects.toThrow();
        expect(await fsPromises.readFile(targetPath, 'utf8')).toBe('export const add = () => 1;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('deletes a DANGLING in-root symlink (just a pointer, target does not exist)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const linkPath = path.join(workspaceRootPath, 'src', 'dangling.ts');
      const missingTarget = path.join(workspaceRootPath, 'src', 'ghost.ts');
      try {
        try {
          await fsPromises.symlink(missingTarget, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];

        const result = await tool.execute({ context: { path: '/src/dangling.ts' } });

        expect(result.ok).toBe(true);
        await expect(fsPromises.lstat(linkPath)).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to delete a LIVE symlink leaf whose target is OUTSIDE the root (target untouched)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-del-ll-'));
      const outsideTarget = path.join(outsideRoot, 'secret.txt');
      const linkPath = path.join(workspaceRootPath, 'src', 'out-alias.ts');
      await fsPromises.writeFile(outsideTarget, 'secret', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.deleteWorkspaceFile'
        ];
        await expect(tool.execute({ context: { path: '/src/out-alias.ts' } })).rejects.toThrow(
          /outside the selected workspace root/i
        );
        // Neither the link nor the outside target was removed.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('secret');
        await expect(fsPromises.lstat(linkPath)).resolves.toBeDefined();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const tool = buildDesktopAssistantTools(undefined)['brainstrike.deleteWorkspaceFile'];
      await expect(tool.execute({ context: { path: '/x.ts' } })).rejects.toThrow(
        /No folder is open/i
      );
    });
  });

  describe('renameWorkspaceFile', () => {
    it('renames a file within the root and reports both paths', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];

        const result = await tool.execute({
          context: { fromPath: '/src/lib/math.ts', toPath: '/src/lib/arithmetic.ts' },
        });

        expect(result).toMatchObject({
          fromPath: '/src/lib/math.ts',
          indexInvalidated: false,
          ok: true,
          toPath: '/src/lib/arithmetic.ts',
        });
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src', 'lib', 'math.ts'))
        ).rejects.toThrow();
        expect(
          await fsPromises.readFile(
            path.join(workspaceRootPath, 'src', 'lib', 'arithmetic.ts'),
            'utf8'
          )
        ).toBe('export const add = () => 1;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('creates missing destination parent directories', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        await tool.execute({
          context: { fromPath: '/README.md', toPath: '/docs/moved/README.md' },
        });
        expect(
          await fsPromises.readFile(
            path.join(workspaceRootPath, 'docs', 'moved', 'README.md'),
            'utf8'
          )
        ).toBe('# Test Workspace\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('invalidates the source path in the workspace index (indexInvalidated: true)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      // getDatabase resolves; the destination re-index seam looks up file_records
      // by identity and finds none (new path → no-op).
      getDatabaseMock.mockResolvedValue({ query: vi.fn(async () => ({ rows: [] })) });
      invalidateManagedCacheMock.mockResolvedValue({
        canceledEmbeddingJobCount: 0,
        deletedChunkIds: ['chunk-src'],
        deletedFileRecordIds: ['rec-src'],
      });
      try {
        const tool = buildDesktopAssistantTools({
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceRootPath,
        } as RuntimeData)['brainstrike.renameWorkspaceFile'];

        const result = await tool.execute({
          context: { fromPath: '/src/lib/math.ts', toPath: '/src/lib/arithmetic.ts' },
        });

        expect(result.ok).toBe(true);
        expect(result.indexInvalidated).toBe(true);
        // Invalidation targets the SOURCE path (root-relative, no leading slash).
        expect(invalidateManagedCacheMock).toHaveBeenCalledWith(expect.anything(), {
          embeddingSetId: 'set-1',
          targets: [{ mode: 'exact', relativePath: 'src/lib/math.ts', rootId: workspaceRootPath }],
        });
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to overwrite an existing destination (no overwrite in v1)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        await expect(
          tool.execute({ context: { fromPath: '/src/lib/math.ts', toPath: '/README.md' } })
        ).rejects.toThrow(/already exists/i);
        // Both files are untouched.
        expect(
          await fsPromises.readFile(path.join(workspaceRootPath, 'src', 'lib', 'math.ts'), 'utf8')
        ).toBe('export const add = () => 1;\n');
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8')).toBe(
          '# Test Workspace\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('throws a not-found error when the source file is missing', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        await expect(
          tool.execute({ context: { fromPath: '/src/nope.ts', toPath: '/src/yep.ts' } })
        ).rejects.toThrow(/does not exist/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to rename a directory', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        await expect(
          tool.execute({ context: { fromPath: '/src/lib', toPath: '/src/library' } })
        ).rejects.toThrow(/is a directory/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('clamps a "../" escape in the destination to inside the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        const result = await tool.execute({
          context: { fromPath: '/README.md', toPath: '../escaped.md' },
        });
        // Unrooted destination keeps the relative convention; ".." is clamped so
        // it resolves INSIDE the root, never the sibling dir.
        expect(result.toPath).toBe('escaped.md');
        await expect(
          fsPromises.access(path.join(path.dirname(workspaceRootPath), 'escaped.md'))
        ).rejects.toThrow();
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'escaped.md'), 'utf8')).toBe(
          '# Test Workspace\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects renaming through a symlinked destination directory that escapes the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-mv-link-'));
      const linkDir = path.join(workspaceRootPath, 'src', 'linked');
      try {
        try {
          await fsPromises.symlink(outsideRoot, linkDir, 'dir');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        await expect(
          tool.execute({ context: { fromPath: '/README.md', toPath: '/src/linked/pwned.md' } })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // Nothing landed in the outside dir and the source is intact.
        await expect(fsPromises.access(path.join(outsideRoot, 'pwned.md'))).rejects.toThrow();
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8')).toBe(
          '# Test Workspace\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('a true swap (a→b concurrent with b→a) contends on the same two lock keys in opposite order and does not deadlock', async () => {
      // This guards withTwoFileLocks' sorted-acquisition invariant specifically.
      // A chain like A→B concurrent with B→C shares only ONE lock key (B), so it
      // can NEVER deadlock under any acquisition order — it doesn't exercise the
      // sort at all. A genuine swap does: both calls lock the SAME two paths
      // {swap-a.ts, swap-b.ts}, but in OPPOSITE from→to order (a→b vs b→a). A
      // naive from-then-to lock order deadlocks here (call1 holds a, waits on b;
      // call2 holds b, waits on a). Sorted acquisition forces both calls to take
      // the two locks in the same physical order, so the pair can only ever run
      // sequentially — never deadlock.
      //
      // Neither rename can legally succeed here (v1 refuses to overwrite an
      // existing destination, and both destinations pre-exist as real swap
      // targets), so the assertion is deliberately "both calls settle without
      // deadlocking", not "both succeed".
      //
      // Path resolution (`resolveWorkspaceWritePath`) normally reaches the lock
      // via `fsPromises.realpath`, a real Node thread-pool op. Empirically (a
      // standalone repro of this exact scenario, thousands of trials), Node
      // drains its microtask queue fully after EVERY thread-pool completion, so
      // one call's ENTIRE lock-registration step always finishes atomically
      // before the other call's continuation can run — through that path, a
      // naive unsorted `withTwoFileLocks` and the sorted one behave IDENTICALLY
      // (never deadlock), because the two calls can never arrive at the lock in
      // the same microtask turn. To actually exercise the interleaved-arrival
      // race the sort defends against, `realpath` is stubbed to resolve via an
      // already-settled promise around a real, synchronous `realpathSync` (same
      // real containment semantics, no thread-pool hop) so both `tool.execute()`
      // calls arrive at the lock in the same microtask burst. Verified locally:
      // with this stub, reverting the sort in `withTwoFileLocks` reproduces the
      // deadlock 20/20 runs; restoring the sort avoids it 20/20 runs.
      const realpathSpy = vi
        .spyOn(fsPromises, 'realpath')
        .mockImplementation((p) => Promise.resolve(realpathSync(p as string)));
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'swap-a.ts'),
          'content a\n',
          'utf8'
        );
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'swap-b.ts'),
          'content b\n',
          'utf8'
        );
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        // Guard: if this ever hangs (e.g. a regression to naive from-then-to lock
        // ordering), fail with a timeout error instead of an infinite hang.
        const results = await Promise.race([
          Promise.allSettled([
            tool.execute({ context: { fromPath: '/swap-a.ts', toPath: '/swap-b.ts' } }),
            tool.execute({ context: { fromPath: '/swap-b.ts', toPath: '/swap-a.ts' } }),
          ]),
          new Promise<'deadlock'>((resolve) => setTimeout(() => resolve('deadlock'), 4000)),
        ]);
        expect(results).not.toBe('deadlock');
        expect(Array.isArray(results)).toBe(true);
        const settled = results as PromiseSettledResult<unknown>[];
        expect(settled).toHaveLength(2);
        for (const outcome of settled) {
          expect(outcome.status).toBe('rejected');
        }
        // Both files are untouched — neither rename could legally proceed, since
        // each one's destination was occupied by the other's source the whole time.
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'swap-a.ts'), 'utf8')).toBe(
          'content a\n'
        );
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'swap-b.ts'), 'utf8')).toBe(
          'content b\n'
        );
      } finally {
        realpathSpy.mockRestore();
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('renames a SYMLINK to an in-root file: the LINK moves (still points at target), target untouched', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      const movedLinkPath = path.join(workspaceRootPath, 'src', 'renamed-alias.ts');
      try {
        try {
          await fsPromises.symlink(targetPath, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];

        const result = await tool.execute({
          context: { fromPath: '/src/alias.ts', toPath: '/src/renamed-alias.ts' },
        });

        expect(result).toMatchObject({
          fromPath: '/src/alias.ts',
          ok: true,
          toPath: '/src/renamed-alias.ts',
        });
        // The old link path is gone; the moved path is STILL a symlink pointing at
        // the original target, and the target file itself was never moved/modified.
        await expect(fsPromises.lstat(linkPath)).rejects.toThrow();
        const movedStats = await fsPromises.lstat(movedLinkPath);
        expect(movedStats.isSymbolicLink()).toBe(true);
        expect(await fsPromises.readlink(movedLinkPath)).toBe(targetPath);
        expect(await fsPromises.readFile(targetPath, 'utf8')).toBe('export const add = () => 1;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to rename a LIVE symlink leaf whose target is OUTSIDE the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-mv-ll-'));
      const outsideTarget = path.join(outsideRoot, 'secret.txt');
      const linkPath = path.join(workspaceRootPath, 'src', 'out-alias.ts');
      await fsPromises.writeFile(outsideTarget, 'secret', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.renameWorkspaceFile'
        ];
        await expect(
          tool.execute({ context: { fromPath: '/src/out-alias.ts', toPath: '/src/moved.ts' } })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // The outside target is intact and nothing was moved into place.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('secret');
        await expect(
          fsPromises.lstat(path.join(workspaceRootPath, 'src', 'moved.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const tool = buildDesktopAssistantTools(undefined)['brainstrike.renameWorkspaceFile'];
      await expect(
        tool.execute({ context: { fromPath: '/a.ts', toPath: '/b.ts' } })
      ).rejects.toThrow(/No folder is open/i);
    });
  });

  it('marks deleteWorkspaceFile as an edit-risk approval-gated action tool', () => {
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.deleteWorkspaceFile']).toMatchObject({
      category: 'action',
      requiresApproval: true,
      riskCategory: 'edit',
    });
  });

  it('marks renameWorkspaceFile as an edit-risk approval-gated action tool', () => {
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.renameWorkspaceFile']).toMatchObject({
      category: 'action',
      requiresApproval: true,
      riskCategory: 'edit',
    });
  });

  it('marks writeWorkspaceFile as an edit-risk approval-gated action tool', () => {
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.writeWorkspaceFile']).toMatchObject({
      category: 'action',
      requiresApproval: true,
      riskCategory: 'edit',
    });
  });

  it('marks stringReplaceWorkspaceFile as an edit-risk approval-gated action tool', () => {
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.stringReplaceWorkspaceFile']).toMatchObject({
      category: 'action',
      requiresApproval: true,
      riskCategory: 'edit',
    });
  });

  it('marks webExtract as a read-risk retrieval tool (no approval, like webSearch)', () => {
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.webExtract']).toMatchObject({
      category: 'retrieval',
      requiresApproval: false,
      riskCategory: 'read',
    });
  });

  it('registers every desktop assistant tool in NATIVE_TOOL_DEFAULTS', () => {
    // Tools absent from NATIVE_TOOL_DEFAULTS are excluded from enabledNativeToolIds
    // (built from NATIVE_TOOL_DEFAULTS) and dropped by buildDesktopAssistantTools
    // in real assistant runs — so a tool registered here but not there works only
    // in tests. Guard against that drift.
    const tools = buildDesktopAssistantTools(undefined);
    const missing = Object.keys(tools).filter((id) => !(id in NATIVE_TOOL_DEFAULTS));
    expect(missing).toEqual([]);
  });

  it('findWorkspaceSymbol applies the workspace read guards (binary / non-file)', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    // Binary file (NUL byte) must error cleanly, not be scanned as UTF-8 garbage.
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'lib', 'bin.dat'),
      Buffer.from([0x41, 0x00, 0x42])
    );
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.findWorkspaceSymbol'];

    await expect(
      tool.execute({ context: { path: '/src/lib/bin.dat', query: 'A' } })
    ).rejects.toThrow(/binary file/i);

    // A directory path must give the friendly "is not a file" error, not EISDIR.
    await expect(tool.execute({ context: { path: '/src/lib', query: 'x' } })).rejects.toThrow(
      /is not a file/i
    );

    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('forwards tapestry range color to the broadcast payload', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const send = vi.fn();
    const hiddenSend = vi.fn();
    getAllWindowsMock.mockReturnValue([
      createMockWindow({ id: 1201, role: 'visible-ui', send }),
      createMockWindow({ id: 1202, role: 'llm-host', send: hiddenSend }),
    ]);
    const tools = buildDesktopAssistantTools({
      selectionFolderId: 'root-1',
      workspaceRootPath,
    } as RuntimeData);

    await tools['brainstrike.updateWorkspaceTapestrySelections'].execute({
      context: {
        mode: 'replace',
        updates: [
          {
            path: '/src/main.ts',
            ranges: [{ color: 'blue', endLine: 2, startLine: 1 }],
          },
        ],
      },
    });

    const tapestryCall = send.mock.calls.find(
      (call) => call[0] === 'assistant:workspace-context-tapestry-update'
    );
    expect(tapestryCall).toBeDefined();
    const capturedTapestryPayload = tapestryCall?.[1] as {
      updates: { ranges: { startLine: number; endLine: number; color?: string }[] }[];
    };
    expect(capturedTapestryPayload.updates[0].ranges[0]).toMatchObject({
      color: 'blue',
      endLine: 2,
      startLine: 1,
    });
    expect(hiddenSend).not.toHaveBeenCalled();
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });
});

describe('assistant-tools multi-root read tools', () => {
  async function createTwoRootWorkspace(): Promise<{
    rootA: string;
    rootB: string;
    cleanup: () => Promise<void>;
  }> {
    const rootA = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-multiroot-a-'));
    const rootB = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-multiroot-b-'));
    // Same relative path, different content — proves the tools disambiguate roots.
    await fsPromises.writeFile(
      path.join(rootA, 'README.md'),
      '# Project A\nexport const fromA = 1;\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(rootB, 'README.md'),
      '# Project B\nexport const fromB = 2;\n',
      'utf8'
    );
    return {
      cleanup: async () => {
        await fsPromises.rm(rootA, { force: true, recursive: true });
        await fsPromises.rm(rootB, { force: true, recursive: true });
      },
      rootA,
      rootB,
    };
  }

  function twoRootRuntime(rootA: string, rootB: string): RuntimeData {
    return {
      workspaceRoots: [
        { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
        { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
      ],
    } as RuntimeData;
  }

  it('reads the file from the root named by `root` and labels the result', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const tool = buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
        'brainstrike.readWorkspaceFile'
      ];

      const fromB = await tool.execute({ path: '/README.md', root: 'ProjectB' });
      expect(fromB.rootName).toBe('ProjectB');
      expect(fromB.content).toContain('Project B');

      const fromA = await tool.execute({ path: '/README.md', root: 'ProjectA' });
      expect(fromA.rootName).toBe('ProjectA');
      expect(fromA.content).toContain('Project A');
    } finally {
      await cleanup();
    }
  });

  it('resolves `root` by id as well as by display name', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const result = await buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
        'brainstrike.readWorkspaceFile'
      ].execute({ path: '/README.md', root: 'id-b' });
      expect(result.content).toContain('Project B');
    } finally {
      await cleanup();
    }
  });

  it('errors and lists the open folders when `root` is omitted and several are open', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      await expect(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
          'brainstrike.readWorkspaceFile'
        ].execute({ path: '/README.md' })
      ).rejects.toThrow(/multiple folders.*ProjectA.*ProjectB/is);
    } finally {
      await cleanup();
    }
  });

  it('errors with the available folders for an unknown `root`', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      await expect(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
          'brainstrike.readWorkspaceFile'
        ].execute({ path: '/README.md', root: 'Nope' })
      ).rejects.toThrow(/no folder "Nope".*ProjectA.*ProjectB/is);
    } finally {
      await cleanup();
    }
  });

  it('lists a directory from the chosen root and labels it', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const result = await buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
        'brainstrike.readWorkspaceDirectory'
      ].execute({ path: '/', root: 'ProjectA' });
      expect(result.rootName).toBe('ProjectA');
      expect(result.entries.some((entry: { path: string }) => entry.path === '/README.md')).toBe(
        true
      );
    } finally {
      await cleanup();
    }
  });

  it('finds a symbol in the chosen root and labels the result', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const result = await buildDesktopAssistantTools(twoRootRuntime(rootA, rootB))[
        'brainstrike.findWorkspaceSymbol'
      ].execute({ path: '/README.md', query: 'fromB', root: 'ProjectB' });
      expect(result.rootName).toBe('ProjectB');
      expect(result.totalMatches).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  describe('manageTaskList provider gating', () => {
    it('registers manageTaskList for a hosted provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'openai' } as RuntimeData);
      expect(tools['brainstrike.manageTaskList']).toBeDefined();
    });

    it('registers manageTaskList when no provider is set (production default)', () => {
      const tools = buildDesktopAssistantTools(undefined);
      expect(tools['brainstrike.manageTaskList']).toBeDefined();
    });

    it('omits manageTaskList for the built-in local provider (WebGPU prefill budget)', () => {
      const tools = buildDesktopAssistantTools({ provider: 'local' } as RuntimeData);
      expect(tools['brainstrike.manageTaskList']).toBeUndefined();
    });

    it('omits manageTaskList for the local provider regardless of case/whitespace', () => {
      const tools = buildDesktopAssistantTools({ provider: '  Local  ' } as RuntimeData);
      expect(tools['brainstrike.manageTaskList']).toBeUndefined();
    });
  });

  describe('suspending tool registration (submitPlan / askUser)', () => {
    it('registers submitPlan and askUser for a hosted provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'openai' } as RuntimeData);
      expect(tools['brainstrike.submitPlan']).toBeDefined();
      expect(tools['brainstrike.askUser']).toBeDefined();
    });

    it('registers the suspending tools when no provider is set (production default)', () => {
      const tools = buildDesktopAssistantTools(undefined);
      expect(tools['brainstrike.submitPlan']).toBeDefined();
      expect(tools['brainstrike.askUser']).toBeDefined();
    });

    it('omits the suspending tools for the built-in local provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'local' } as RuntimeData);
      expect(tools['brainstrike.submitPlan']).toBeUndefined();
      expect(tools['brainstrike.askUser']).toBeUndefined();
    });

    it('registers the factory Tool objects directly so they keep suspendSchema', () => {
      // Re-wrapping in the registry's { description, execute, id, inputSchema }
      // literal shape would DROP suspendSchema and break suspension + the
      // hasSuspendSchema fail-safe. The built entries must carry it.
      const tools = buildDesktopAssistantTools({ provider: 'anthropic' } as RuntimeData);
      expect(
        (tools['brainstrike.submitPlan'] as { suspendSchema?: unknown }).suspendSchema
      ).toBeDefined();
      expect(
        (tools['brainstrike.submitPlan'] as { resumeSchema?: unknown }).resumeSchema
      ).toBeDefined();
      expect(
        (tools['brainstrike.askUser'] as { suspendSchema?: unknown }).suspendSchema
      ).toBeDefined();
    });

    it('passes the suspending tool ids through the enabled-tool allowlist filter', () => {
      const tools = buildDesktopAssistantTools({
        enabledNativeToolIds: ['brainstrike.submitPlan', 'brainstrike.askUser'],
        provider: 'openai',
      } as RuntimeData);
      expect(tools['brainstrike.submitPlan']).toBeDefined();
      expect(tools['brainstrike.askUser']).toBeDefined();
      expect(tools['brainstrike.readWorkspaceFile']).toBeUndefined();
    });
  });

  describe('post-edit LSP diagnostics (report R2)', () => {
    // Real typescript-language-server subprocess — dispose after each so no
    // pooled server orphans across tests.
    afterEach(async () => {
      await disposeLspServers();
    });

    async function createLspWorkspace(): Promise<string> {
      const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-lsp-edit-'));
      await fsPromises.mkdir(path.join(root, 'src'), { recursive: true });
      await fsPromises.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}', 'utf8');
      return realpathSync(root);
    }

    it('attaches diagnostics to a stringReplace that introduces a type error', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'typed.ts'),
          'export const value: number = 1;\n',
          'utf8'
        );

        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-thread' },
          workspaceRootPath,
        } as RuntimeData);
        // Read first so the R8 staleness guard has a fresh observation.
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/typed.ts' },
        });

        const result = await tools['brainstrike.stringReplaceWorkspaceFile'].execute({
          context: {
            newStr: 'export const value: number = "not a number";',
            oldStr: 'export const value: number = 1;',
            path: '/src/typed.ts',
          },
        });

        expect(result.replaced).toBe(true);
        expect(result.lsp?.available).toBe(true);
        expect(result.lsp?.language).toBe('typescript');
        expect(result.lsp?.diagnostics?.length ?? 0).toBeGreaterThan(0);
        expect(result.lsp?.diagnostics?.[0]?.message).toMatch(/not assignable/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('omits the lsp field entirely for a non-code (markdown) write', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-thread-2' },
          workspaceRootPath,
        } as RuntimeData);

        const result = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Notes\n', path: '/notes.md' },
        });

        expect(result.created).toBe(true);
        expect(result.lsp).toBeUndefined();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect returns hover + definition for a symbol via the <<< cursor (Phase B)', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'sym.ts'),
          'export const greeting: string = "hi";\nexport const echo = greeting;\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-inspect' },
          workspaceRootPath,
        } as RuntimeData);

        const result = await tools['brainstrike.lspInspect'].execute({
          context: {
            line: 2,
            match: 'export const echo = <<<greeting;',
            path: '/src/sym.ts',
          },
        });

        expect(result.available).toBe(true);
        expect(result.hover).toMatch(/string/);
        expect(result.definition?.[0]?.path).toBe('/src/sym.ts');
        expect(result.definition?.[0]?.line).toBe(1);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect resolves a line-fragment match to the correct column (review)', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'sym.ts'),
          'export const greeting: string = "hi";\nexport const pair = { a: greeting, b: greeting };\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-inspect-fragment' },
          workspaceRootPath,
        } as RuntimeData);

        // A fragment of line 2 (not the full line): the cursor column must be
        // fragment-start-in-line + marker-offset-in-fragment, pointing at the
        // SECOND `greeting`. Raw indexOf on the fragment would yield column 3
        // (mid-"export") and silently inspect nothing.
        const result = await tools['brainstrike.lspInspect'].execute({
          context: {
            line: 2,
            match: 'b: <<<greeting',
            path: '/src/sym.ts',
          },
        });

        expect(result.available).toBe(true);
        expect(result.hover).toMatch(/string/);
        expect(result.definition?.[0]?.path).toBe('/src/sym.ts');
        expect(result.definition?.[0]?.line).toBe(1);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect refuses a match that does not occur on the target line (review)', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'x.ts'),
          'export const x = 1;\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-stale-match' },
          workspaceRootPath,
        } as RuntimeData);

        await expect(
          tools['brainstrike.lspInspect'].execute({
            // Model quoted a line that isn't the real line 1 → must refuse with
            // the actual line text, never inspect a wrong column.
            context: { line: 1, match: 'const nonexistent = <<<thing;', path: '/src/x.ts' },
          })
        ).rejects.toThrow(/not found on line 1/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect refuses an ambiguous line fragment (review)', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'dup.ts'),
          'export const pair = { a: value, b: value };\nexport const value = 1;\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-ambiguous' },
          workspaceRootPath,
        } as RuntimeData);

        await expect(
          tools['brainstrike.lspInspect'].execute({
            // "value" appears twice on line 1 → the column is ambiguous.
            context: { line: 1, match: '<<<value', path: '/src/dup.ts' },
          })
        ).rejects.toThrow(/more than once/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect refuses a malformed cursor marker with an actionable error', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'x.ts'),
          'export const x = 1;\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools({
          memory: { resourceId: 'r', runId: 'run', threadId: 'lsp-bad-cursor' },
          workspaceRootPath,
        } as RuntimeData);

        await expect(
          tools['brainstrike.lspInspect'].execute({
            // Two markers → invalid.
            context: { line: 1, match: 'export <<<const <<<x = 1;', path: '/src/x.ts' },
          })
        ).rejects.toThrow(/exactly one/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);
  });
});
