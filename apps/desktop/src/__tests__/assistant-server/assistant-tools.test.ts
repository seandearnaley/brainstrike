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

  it('selects root tree files for preview population', async () => {
    const sendMock = vi.fn();
    getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send: sendMock },
      },
    ]);

    const runtimeData = { selectionFolderId: 'root-1' } as RuntimeData;
    const tools = buildDesktopAssistantTools(runtimeData);
    const tool = tools['brainstrike.selectRootTreeFiles'];

    const result = await tool.execute({
      context: {
        filePaths: ['/src/main.ts', '/src/utils.ts'],
        mode: 'add',
      },
    });

    expect(result.folderId).toBe('root-1');
    expect(result.selectionSet).toBe('rootTree');
    expect(result.mode).toBe('add');
    expect(result.appliedCount).toBe(2);
    expect(sendMock).toHaveBeenCalledWith('assistant:root-tree-selection-update', {
      folderId: 'root-1',
      filePaths: ['/src/main.ts', '/src/utils.ts'],
      mode: 'add',
    });
  });

  it('updates preview context files when execute receives direct args', async () => {
    const sendMock = vi.fn();
    getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send: sendMock },
      },
    ]);

    const runtimeData = { selectionFolderId: 'root-1' } as RuntimeData;
    const tools = buildDesktopAssistantTools(runtimeData);
    const tool = tools['brainstrike.updatePreviewContextFiles'];

    const result = await tool.execute({
      filePaths: ['/src/main.ts'],
      mode: 'remove',
    });

    expect(result.selectionSet).toBe('previewContext');
    expect(result.appliedCount).toBe(1);
    expect(sendMock).toHaveBeenCalledWith('assistant:preview-context-selection-update', {
      folderId: 'root-1',
      filePaths: ['/src/main.ts'],
      mode: 'remove',
    });
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
