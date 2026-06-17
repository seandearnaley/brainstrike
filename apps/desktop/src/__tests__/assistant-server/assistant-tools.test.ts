import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_TOOL_DEFAULTS, type RuntimeData } from '@brainstrike/agent';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
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

const { getDatabaseMock, getAllWindowsMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

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
        path: '/src/main.ts',
        startLine: 2,
        endLine: 4,
        maxChars: 12,
      },
    });

    expect(result.path).toBe('/src/main.ts');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(4);
    expect(result.totalLines).toBe(4);
    expect(result.content).toBe('line 2\nline ');
    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBeGreaterThan(0);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('reads a workspace file when execute receives direct args', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceFile'];

    const result = await tool.execute({
      path: '/src/main.ts',
      startLine: 1,
      endLine: 2,
      maxChars: 50,
    });

    expect(result.path).toBe('/src/main.ts');
    expect(result.content).toContain('line 1');
    expect(result.truncated).toBe(false);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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
      await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
      await fsPromises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('reads a workspace directory in compact form', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const result = await tool.execute({
      context: {
        path: '/src',
        depth: 2,
        maxEntries: 10,
        includeFiles: true,
        includeDirectories: true,
      },
    });

    expect(result.path).toBe('/src');
    expect(result.count).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.path === '/src/components')).toBe(true);
    expect(result.entries.some((entry) => entry.path === '/src/main.ts')).toBe(true);
    expect(result.truncated).toBe(false);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('lists the workspace root for path "." (regression: "." was treated as a hidden segment)', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const result = await tool.execute({
      context: {
        path: '.',
        depth: 5,
        maxEntries: 150,
        includeFiles: true,
        includeDirectories: true,
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
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('reads a workspace directory when execute receives direct args', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const result = await tool.execute({
      path: '/src',
      depth: 2,
      maxEntries: 10,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: false,
    });

    expect(result.path).toBe('/src');
    expect(result.entries.some((entry) => entry.path === '/src/main.ts')).toBe(true);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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

    const detailed = await tool.execute({ path: '/src', detail: true });
    const detailedFile = detailed.entries.find((entry) => entry.type === 'file');
    expect(detailedFile).toHaveProperty('size');
    expect(detailedFile).toHaveProperty('depth');

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('pages directory entries with offset and emits a continuation hint when truncated', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    const firstPage = await tool.execute({ path: '/src', maxEntries: 2 });
    expect(firstPage.entries.length).toBe(2);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.hint).toContain('offset: 2');

    const secondPage = await tool.execute({ path: '/src', maxEntries: 2, offset: 2 });
    expect(secondPage.offset).toBe(2);
    expect(secondPage.entries.length).toBeGreaterThan(0);
    expect(secondPage.entries[0]?.path).not.toBe(firstPage.entries[0]?.path);

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('exposes tool-only context tools and omits legacy context mutation tools from chat runtime', () => {
    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    expect(tools['brainstrike.listWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.readWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.listEmbeddingSpaces']).toBeDefined();
    expect(tools['brainstrike.queryEmbeddingSpace']).toBeDefined();
    expect(tools['brainstrike.updateWorkspaceContextSelection']).toBeDefined();
    expect(tools['brainstrike.updateWorkspaceTapestrySelections']).toBeDefined();
    expect(tools['brainstrike.selectRootTreeFiles']).toBeUndefined();
    expect(tools['brainstrike.updatePreviewContextFiles']).toBeUndefined();
  });

  it('executes the grepSearch tool end-to-end with context-wrapped input', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });
    getDatabaseMock.mockResolvedValue({ query: queryMock });

    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    const result = await tools['brainstrike.grepSearch'].execute({
      context: { pattern: 'needle', outputMode: 'content' },
    });

    expect(result.matches).toEqual([
      {
        path: 'src/x.ts',
        line: 11,
        lineText: 'needle line',
        before: ['alpha'],
        after: ['omega'],
      },
    ]);
  });

  it('executes the grepSearch tool in default files mode with context-wrapped input', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });
    getDatabaseMock.mockResolvedValue({ query: queryMock });

    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    const result = await tools['brainstrike.grepSearch'].execute({
      context: { pattern: 'needle' },
    });

    expect(result.outputMode).toBe('files');
    expect(result.files).toEqual([{ path: 'src/x.ts', matchCount: 1, firstLine: 11 }]);
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
      workspaceRootPath: '/tmp/workspace',
      enabledNativeToolIds: ['brainstrike.listWorkspaceContext'],
    } as RuntimeData);

    expect(tools['brainstrike.listWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.readWorkspaceFile']).toBeUndefined();
    expect(tools['brainstrike.queryEmbeddingSpace']).toBeUndefined();
  });

  it('lists selected workspace context without returning file contents', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFolderId: 'root-1',
      selectionFilePaths: ['/src/main.ts', '/README.md'],
      workspaceIndexEmbeddingSetId: 'set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
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
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('reports selected files living in OTHER workspace roots (multi-root forest)', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFolderId: 'root-1',
      selectionFilePaths: ['/src/main.ts'],
      // Multi-root: 4 selected files belong to roots the single-root toolset
      // cannot address — the count must be SURFACED, never silently dropped.
      selectionFilePathsFromOtherRoots: 4,
      workspaceIndexingEnabled: false,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
    } as RuntimeData);

    const result = await tools['brainstrike.listWorkspaceContext'].execute({ context: {} });

    expect(result.selectedFileCount).toBe(1);
    expect(result.selectedFilesOutsideWorkspace).toBe(4);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('lists every open workspace root so the model can qualify the other tools', async () => {
    const tools = buildDesktopAssistantTools({
      workspaceRoots: [
        { rootId: 'id-a', displayName: 'ProjectA', path: '/work/ProjectA' },
        { rootId: 'id-b', displayName: 'ProjectB', path: '/work/ProjectB' },
      ],
      selectionFilePaths: [],
      workspaceIndexingEnabled: false,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
    } as unknown as RuntimeData);

    const result = await tools['brainstrike.listWorkspaceContext'].execute({ context: {} });

    expect(result.workspaceRoots).toEqual([
      { rootId: 'id-a', displayName: 'ProjectA', path: '/work/ProjectA' },
      { rootId: 'id-b', displayName: 'ProjectB', path: '/work/ProjectB' },
    ]);
  });

  it('synthesizes a single-root list from the legacy workspaceRootPath', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const result = await buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths: [],
      workspaceIndexingEnabled: false,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
    } as RuntimeData)['brainstrike.listWorkspaceContext'].execute({ context: {} });

    expect(result.workspaceRoots).toHaveLength(1);
    expect(result.workspaceRoots[0]?.path).toBe(workspaceRootPath);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('lists token-aware curated workspace context metadata without file contents', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFolderId: 'root-1',
      selectionFilePaths: ['/src/main.ts', '/README.md'],
      workspaceContext: {
        tokenBudget: 8192,
        selectedSourceApproxTokens: 240,
        selectedOutputApproxTokens: 140,
        useTapestryRanges: true,
        includeProjectTree: false,
        projectTreeApproxTokens: 1800,
        projectTreeTokenCountLoading: false,
        files: [
          {
            path: '/src/main.ts',
            approxTokens: 200,
            outputApproxTokens: 100,
            ranges: [{ startLine: 2, endLine: 3, approxTokens: 20, isActive: true }],
          },
          { path: '/README.md', approxTokens: 40, outputApproxTokens: 40, ranges: [] },
        ],
      },
    } as RuntimeData);

    const conciseResult = await tools['brainstrike.listWorkspaceContext'].execute({
      context: { includeTokenEstimates: true },
    });

    // Concise default: counts and token budgets only, no per-file range metadata.
    expect(conciseResult.curatedContext).toBeUndefined();
    expect(conciseResult.curatedContextSummary).toEqual({
      fileCount: 2,
      rangeCount: 1,
      tokenBudget: 8192,
      useTapestryRanges: true,
      includeProjectTree: false,
      projectTreeApproxTokens: 1800,
      selectedSourceApproxTokens: 240,
      selectedOutputApproxTokens: 140,
    });
    expect(conciseResult.truncated).toBe(false);

    const result = await tools['brainstrike.listWorkspaceContext'].execute({
      context: { includeTokenEstimates: true, detail: true },
    });

    expect(result.curatedContext).toEqual({
      tokenBudget: 8192,
      selectedSourceApproxTokens: 240,
      selectedOutputApproxTokens: 140,
      useTapestryRanges: true,
      includeProjectTree: false,
      projectTreeApproxTokens: 1800,
      projectTreeTokenCountLoading: false,
      files: [
        {
          path: '/src/main.ts',
          approxTokens: 200,
          outputApproxTokens: 100,
          ranges: [{ startLine: 2, endLine: 3, approxTokens: 20, isActive: true }],
        },
        { path: '/README.md', approxTokens: 40, outputApproxTokens: 40, ranges: [] },
      ],
    });
    expect(result.tokenEstimates).toEqual([
      { path: '/src/main.ts', approxTokens: 200 },
      { path: '/README.md', approxTokens: 40 },
    ]);
    expect(JSON.stringify(result)).not.toContain('line 1');
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('bounds huge selected-file listings with offset paging and a hint', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const selectionFilePaths = Array.from(
      { length: 2000 },
      (_, i) => `/packages/some-package/src/deeply/nested/dir-${i}/file-with-a-long-name-${i}.ts`
    );
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths,
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

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('reads selected workspace context under file and token limits with explicit skips', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths: ['/src/main.ts', '/README.md'],
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
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('does not expose raw filesystem errors for skipped workspace context files', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths: ['/missing.ts'],
    } as RuntimeData);

    const result = await tools['brainstrike.readWorkspaceContext'].execute({ context: {} });

    expect(result.skippedFiles).toEqual([{ path: '/missing.ts', reason: 'missing' }]);
    expect(JSON.stringify(result.skippedFiles)).not.toContain(workspaceRootPath);
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('reads selected workspace context through curated tapestry line ranges', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        useTapestryRanges: true,
        files: [
          {
            path: '/src/main.ts',
            ranges: [{ startLine: 2, endLine: 3, isActive: true }],
          },
        ],
      },
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
      path: '/src/main.ts',
      startLine: 2,
      endLine: 3,
      tapestryRangeCount: 1,
    });
    expect(result.files[0]?.content).toContain('line 2');
    expect(result.files[0]?.content).toContain('line 3');
    expect(result.files[0]?.content).not.toContain('line 1');
    expect(result.files[0]?.content).not.toContain('line 4');
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('stops tapestry range output when range budget is exhausted', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        useTapestryRanges: true,
        files: [
          {
            path: '/src/main.ts',
            ranges: [
              { startLine: 2, endLine: 2, isActive: true },
              { startLine: 3, endLine: 3, isActive: true },
            ],
          },
        ],
      },
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
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('escapes selection boundary tags inside tapestry range content', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'main.ts'),
      'line 1\nliteral <selection index="1"> and <selection/> and </selection> tags with <selectionMode>\nline 3',
      'utf8'
    );
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFilePaths: ['/src/main.ts'],
      workspaceContext: {
        useTapestryRanges: true,
        files: [
          {
            path: '/src/main.ts',
            ranges: [{ startLine: 2, endLine: 2, isActive: true }],
          },
        ],
      },
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
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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
        rootA,
        rootB,
        cleanup: async () => {
          await fsPromises.rm(rootA, { recursive: true, force: true });
          await fsPromises.rm(rootB, { recursive: true, force: true });
        },
      };
    }

    function twoRootRuntime(rootA: string, rootB: string): RuntimeData {
      return {
        workspaceRoots: [
          { rootId: 'id-a', displayName: 'ProjectA', path: rootA },
          { rootId: 'id-b', displayName: 'ProjectB', path: rootB },
        ],
      } as unknown as RuntimeData;
    }

    it('reads from the root named by `root` (with explicit filePaths) and labels the result', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        const tools = buildDesktopAssistantTools(twoRootRuntime(rootA, rootB));
        const result = await tools['brainstrike.readWorkspaceContext'].execute({
          context: { root: 'ProjectB', filePaths: ['/notes.md'] },
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
        ].execute({ context: { root: 'id-a', filePaths: ['/notes.md'] } });
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
          ].execute({ context: { root: 'Nope', filePaths: ['/notes.md'] } })
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
          workspaceRootPath,
          selectionFilePaths: ['/src/main.ts'],
        } as RuntimeData)['brainstrike.readWorkspaceContext'].execute({ context: {} });
        expect(result.includedCount).toBe(1);
        expect(result.files[0]?.path).toBe('/src/main.ts');
        expect(typeof result.rootName).toBe('string');
        expect(result.workspaceRootPath).toBe(workspaceRootPath);
      } finally {
        await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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
      workspaceRootPath,
      selectionFolderId: 'root-1',
    } as RuntimeData);

    const result = await tools['brainstrike.updateWorkspaceContextSelection'].execute({
      context: {
        filePaths: ['/src/main.ts', '/missing.ts'],
        mode: 'replace',
      },
    });

    expect(result).toMatchObject({
      folderId: 'root-1',
      mode: 'replace',
      requestedCount: 2,
      appliedCount: 1,
      skippedCount: 1,
      selectedFiles: ['/src/main.ts'],
      skippedFiles: [{ path: '/missing.ts', reason: 'missing' }],
      notifiedWindowCount: 1,
    });
    expect(result.skippedFiles[0]).not.toHaveProperty('message');
    expect(JSON.stringify(result.skippedFiles)).not.toContain(workspaceRootPath);
    expect(send).toHaveBeenCalledWith('assistant:workspace-context-selection-update', {
      folderId: 'root-1',
      filePaths: ['/src/main.ts'],
      mode: 'replace',
    });
    expect(hiddenSend).not.toHaveBeenCalled();
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  describe('selection write-back multi-root routing', () => {
    function routingRuntime(rootA: string, rootB: string): RuntimeData {
      return {
        workspaceRootPath: rootA,
        selectionFolderId: 'client-a',
        workspaceRoots: [
          { rootId: 'id-a', displayName: 'ProjectA', path: rootA },
          { rootId: 'id-b', displayName: 'ProjectB', path: rootB },
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
          expect.objectContaining({ rootPath: rootB, rootId: 'id-b', mode: 'replace' })
        );
      } finally {
        await fsPromises.rm(rootA, { recursive: true, force: true });
        await fsPromises.rm(rootB, { recursive: true, force: true });
      }
    });

    it('omits rootPath for the legacy single/focused-root path (renderer routes by folderId)', async () => {
      const rootA = await createWorkspaceFixture();
      const send = vi.fn();
      getAllWindowsMock.mockReturnValue([createMockWindow({ id: 2002, role: 'visible-ui', send })]);
      try {
        await buildDesktopAssistantTools({
          workspaceRootPath: rootA,
          selectionFolderId: 'client-a',
        } as RuntimeData)['brainstrike.updateWorkspaceContextSelection'].execute({
          context: { filePaths: ['/src/main.ts'], mode: 'replace' },
        });
        const payload = send.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
        expect(payload).toMatchObject({ folderId: 'client-a' });
        expect(payload).not.toHaveProperty('rootPath');
      } finally {
        await fsPromises.rm(rootA, { recursive: true, force: true });
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
        await fsPromises.rm(rootA, { recursive: true, force: true });
        await fsPromises.rm(rootB, { recursive: true, force: true });
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
            updates: [{ path: '/src/main.ts', ranges: [{ startLine: 1, endLine: 2 }] }],
          },
        });
        expect(send).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ rootPath: rootB, rootId: 'id-b' })
        );
      } finally {
        await fsPromises.rm(rootA, { recursive: true, force: true });
        await fsPromises.rm(rootB, { recursive: true, force: true });
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
      workspaceRootPath,
      selectionFolderId: 'root-1',
    } as RuntimeData);

    const result = await tools['brainstrike.updateWorkspaceTapestrySelections'].execute({
      context: {
        mode: 'replace',
        selectFiles: true,
        updates: [
          {
            path: '/src/main.ts',
            ranges: [{ startLine: 2, endLine: 3, isActive: true }],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      folderId: 'root-1',
      mode: 'replace',
      requestedFileCount: 1,
      appliedFileCount: 1,
      skippedFileCount: 0,
      notifiedWindowCount: 1,
    });
    expect(send).toHaveBeenNthCalledWith(1, 'assistant:workspace-context-selection-update', {
      folderId: 'root-1',
      filePaths: ['/src/main.ts'],
      mode: 'add',
    });
    expect(send).toHaveBeenNthCalledWith(2, 'assistant:workspace-context-tapestry-update', {
      folderId: 'root-1',
      mode: 'replace',
      updates: [
        {
          path: '/src/main.ts',
          ranges: [{ startLine: 2, endLine: 3, isActive: true }],
        },
      ],
    });
    expect(hiddenSend).not.toHaveBeenCalled();
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
  });

  it('lists embedding spaces with optional coverage stats', async () => {
    getDatabaseMock.mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                id: 'set-1',
                name: 'Main',
                description: null,
                modelKey: 'openai:text-embedding-3-small',
                modelId: 'text-embedding-3-small',
                dimensions: 1536,
                distance: 'cosine',
                createdAt: '2026-01-01T00:00:00.000Z',
                embeddedChunks: '3',
                fileCount: '2',
                tokenizedChunkCount: '4',
                totalChunks: '5',
                totalTokens: '40',
                averageTokensPerChunk: '10',
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
      id: 'set-1',
      name: 'Main',
      modelKey: 'openai:text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      isWorkspaceIndex: true,
      recommendedForWorkspaceSearch: true,
      coverage: {
        embeddedChunks: 3,
        fileCount: 2,
        tokenizedChunkCount: 4,
        totalChunks: 5,
        totalTokens: 40,
        averageTokensPerChunk: 10,
        coveragePercent: 60,
      },
    });
  });

  it('preserves nullable embedding space names in tool output', async () => {
    getDatabaseMock.mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return {
            rows: [
              {
                id: 'set-1',
                name: null,
                description: null,
                modelKey: 'local:Xenova/all-MiniLM-L6-v2',
                modelId: 'Xenova/all-MiniLM-L6-v2',
                dimensions: 384,
                distance: 'cosine',
                createdAt: '2026-01-01T00:00:00.000Z',
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
        id: 'set-1',
        name: null,
        createdAt: '2026-01-01T00:00:00.000Z',
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
                id: 'set-1',
                name: 'Workspace Index',
                description: null,
                modelKey: 'openai:text-embedding-3-small',
                modelId: 'text-embedding-3-small',
                dimensions: 1536,
                distance: 'cosine',
                createdAt: '2026-01-02T00:00:00.000Z',
              },
              {
                id: 'set-2',
                name: 'Scratch',
                description: null,
                modelKey: 'openai:text-embedding-3-small',
                modelId: 'text-embedding-3-small',
                dimensions: 1536,
                distance: 'cosine',
                createdAt: '2026-01-01T00:00:00.000Z',
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
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexStatusState: 'blocked',
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 0,
        pending: 0,
        processed: 0,
        totalQueued: 0,
      },
    } as RuntimeData);
    const tool = tools['brainstrike.queryEmbeddingSpace'];

    const result = await tool.execute({
      context: {
        query: 'where is context assembled?',
      },
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'workspace-index-blocked',
      workspaceIndex: {
        embeddingSetId: 'workspace-index-set',
        blockedReason: 'missing-provider-key',
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

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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
    expect(result.matches[0]).toMatchObject({ declarationLine: 1, startLine: 1, endLine: 3 });
    expect(result.path).toBe('/src/lib/math.ts');
    expect(result).not.toHaveProperty('content');

    const none = await tool.execute({ context: { path: '/src/lib/math.ts', query: 'nope' } });
    expect(none).toMatchObject({ matches: [], totalMatches: 0, truncated: false });

    await expect(
      tool.execute({ context: { path: '../outside.ts', query: 'x' } })
    ).rejects.toThrow();

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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

    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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
      workspaceRootPath,
      selectionFolderId: 'root-1',
    } as RuntimeData);

    await tools['brainstrike.updateWorkspaceTapestrySelections'].execute({
      context: {
        mode: 'replace',
        updates: [
          {
            path: '/src/main.ts',
            ranges: [{ startLine: 1, endLine: 2, color: 'blue' }],
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
      startLine: 1,
      endLine: 2,
      color: 'blue',
    });
    expect(hiddenSend).not.toHaveBeenCalled();
    await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
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
      rootA,
      rootB,
      cleanup: async () => {
        await fsPromises.rm(rootA, { recursive: true, force: true });
        await fsPromises.rm(rootB, { recursive: true, force: true });
      },
    };
  }

  function twoRootRuntime(rootA: string, rootB: string): RuntimeData {
    return {
      workspaceRoots: [
        { rootId: 'id-a', displayName: 'ProjectA', path: rootA },
        { rootId: 'id-b', displayName: 'ProjectB', path: rootB },
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
});
