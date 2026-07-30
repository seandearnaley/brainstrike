import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_TOOL_DEFAULTS,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RuntimeData,
} from '@brainstrike/agent';
import { DESKTOP_NATIVE_TOOL_IDS, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
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

// Split from the 5,101-line assistant-tools.integration.test.ts (BST-976):
// one suite per service seam, sharing the fixture module and repeating the
// vi.mock preamble per file (hoisting is per-importing-module).
describe('assistant-tools edit lifecycle', () => {
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

  it('marks the artifact reader as a deferred read-only retrieval tool', () => {
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.readToolOutputArtifact']).toMatchObject({
      category: 'retrieval',
      loadingTier: 'deferred',
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

  it('keeps the live desktop registry identical to the canonical catalog', () => {
    const tools = buildDesktopAssistantTools({ provider: 'openai' } as RuntimeData, {
      skillScriptResolver: {
        resolveScriptExecution: async () => {
          throw new Error('not executed by registry parity test');
        },
      },
      toolOutputArtifactReader: {
        readRange: async () => ({ status: 'not_found' }),
      },
    });

    expect(Object.keys(tools).sort()).toEqual([...DESKTOP_NATIVE_TOOL_IDS].sort());
    for (const toolId of DESKTOP_NATIVE_TOOL_IDS) {
      const tool = tools[toolId];
      expect(tool?.id).toBe(toolId);
      expect(tool?.description).toBe(TOOL_DESCRIPTIONS[toolId]);
      expect(tool?.inputSchema).toBe(NATIVE_TOOL_INPUT_SCHEMAS[toolId]);
    }
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
