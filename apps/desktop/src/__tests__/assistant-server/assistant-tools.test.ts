import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

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

  it('exposes tool-only context tools and omits context mutation tools from chat runtime', () => {
    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);

    expect(tools['brainstrike.listWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.readWorkspaceContext']).toBeDefined();
    expect(tools['brainstrike.listEmbeddingSpaces']).toBeDefined();
    expect(tools['brainstrike.queryEmbeddingSpace']).toBeDefined();
    expect(tools['brainstrike.selectRootTreeFiles']).toBeUndefined();
    expect(tools['brainstrike.updatePreviewContextFiles']).toBeUndefined();
  });

  it('lists selected workspace context without returning file contents', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      workspaceRootPath,
      selectionFolderId: 'root-1',
      selectionFilePaths: ['/src/main.ts', '/README.md'],
    } as RuntimeData);
    const tool = tools['brainstrike.listWorkspaceContext'];

    const result = await tool.execute({ context: {} });

    expect(result.workspaceRootPath).toBe(workspaceRootPath);
    expect(result.selectionFolderId).toBe('root-1');
    expect(result.selectedFileCount).toBe(2);
    expect(result.selectedFiles).toEqual(['/src/main.ts', '/README.md']);
    expect(JSON.stringify(result)).not.toContain('line 1');
    expect(JSON.stringify(result)).not.toContain('# Test Workspace');
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
                totalChunks: '5',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    });
    const tools = buildDesktopAssistantTools(undefined);
    const tool = tools['brainstrike.listEmbeddingSpaces'];

    const result = await tool.execute({ context: { includeStats: true } });

    expect(result.count).toBe(1);
    expect(result.spaces[0]).toMatchObject({
      id: 'set-1',
      name: 'Main',
      modelKey: 'openai:text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      coverage: {
        embeddedChunks: 3,
        totalChunks: 5,
        coveragePercent: 60,
      },
    });
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

  it('rejects invalid directory payloads instead of crashing', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceDirectory'];

    await expect(
      tool.execute({
        path: null,
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
      'No workspace root is available. Open/select a folder in the left file tree first.'
    );
  });
});
