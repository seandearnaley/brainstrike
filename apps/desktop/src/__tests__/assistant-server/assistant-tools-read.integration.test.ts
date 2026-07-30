import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  NATIVE_TOOL_INPUT_SCHEMAS,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  type RuntimeData,
  withFileLock,
} from '@brainstrike/agent';
import { ToolInputError, type ToolOutputArtifactReference } from '@brainstrike/assistant-contract';
import { encodeToolOutputArtifactCursor } from '@brainstrike/assistant-contract/tool-output-artifact';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import type { CommandSessionManager } from '../../assistant-server/command-session-manager';
import {
  COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES,
  type CommandSessionPayloadTransform,
} from '../../assistant-server/command-session-tools';
import { ReadWorkspaceFileCursorRegistry } from '../../assistant-server/read-workspace-file-cursor-registry';
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
describe('assistant-tools read tools', () => {
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

  function workspaceRuntime(workspaceRootPath: string, threadId = 'assistant-tools-thread') {
    return {
      memory: { resourceId: 'assistant-tools-workspace', threadId },
      workspaceRootPath,
    } as RuntimeData;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const id of trackedWindowIds) {
      clearWindowRoleByWebContentsId(id);
    }
    trackedWindowIds.length = 0;
  });

  it('reads a line-numbered workspace file page with a short continuation handle', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    const tools = buildDesktopAssistantTools({
      memory: { resourceId: 'workspace', threadId: 'thread-a' },
      workspaceRootPath,
    } as RuntimeData);
    const tool = tools['brainstrike.readWorkspaceFile'];

    const result = await tool.execute({
      context: {
        endLine: 4,
        maxChars: 10,
        path: '/src/main.ts',
        startLine: 2,
      },
    });

    expect(result.path).toBe('/src/main.ts');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(2);
    expect(result.totalLines).toBe(4);
    expect(result.content).toBe('2: line 2');
    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(result.nextCursor).toMatch(/^rfh_[A-Za-z0-9_-]{22}$/);

    const continued = await tool.execute({
      cursor: result.nextCursor,
      maxChars: 10,
    });
    expect(continued).toMatchObject({
      content: '3: line 3',
      endLine: 3,
      startLine: 3,
      truncated: true,
    });
    expect(continued.nextCursor).toEqual(expect.any(String));
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('accepts an unchanged provider-emitted range replay and rejects a changed range', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
      'brainstrike.readWorkspaceFile'
    ];

    try {
      const first = await tool.execute({
        endLine: 4,
        maxChars: 10,
        path: '/src/main.ts',
        startLine: 2,
      });

      await expect(
        tool.execute({
          cursor: first.nextCursor,
          endLine: 3,
          maxChars: 10,
        })
      ).rejects.toThrow(/original startLine\/endLine unchanged/i);

      const continued = await tool.execute({
        cursor: first.nextCursor,
        endLine: 4,
        maxChars: 10,
        path: null,
        root: null,
        startLine: null,
      });
      expect(continued.content).toBe('3: line 3');
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('reclaims a completed page handle before issuing the next handle', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    let handleNumber = 0;
    const cursorRegistry = new ReadWorkspaceFileCursorRegistry({
      createHandle: () => `rfh_${String(handleNumber++).padStart(22, 'a')}`,
      maxEntries: 1,
    });
    const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath), {
      readWorkspaceFileCursorRegistry: cursorRegistry,
    })['brainstrike.readWorkspaceFile'];

    try {
      const first = await tool.execute({
        maxChars: 10,
        path: '/src/main.ts',
      });
      const continued = await tool.execute({
        cursor: first.nextCursor,
        maxChars: 10,
      });

      expect(continued.content).toBe('2: line 2');
      expect(continued.nextCursor).toMatch(/^rfh_[A-Za-z0-9_-]{22}$/);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('rejects a read continuation handle from another assistant thread', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const firstThreadTool = buildDesktopAssistantTools({
      memory: { resourceId: 'workspace', threadId: 'thread-a' },
      workspaceRootPath,
    } as RuntimeData)['brainstrike.readWorkspaceFile'];
    const otherThreadTool = buildDesktopAssistantTools({
      memory: { resourceId: 'workspace', threadId: 'thread-b' },
      workspaceRootPath,
    } as RuntimeData)['brainstrike.readWorkspaceFile'];

    try {
      const first = await firstThreadTool.execute({
        maxChars: 10,
        path: '/src/main.ts',
      });

      await expect(
        otherThreadTool.execute({
          cursor: first.nextCursor,
          maxChars: 10,
        })
      ).rejects.toThrow(/continuation handle belongs to another assistant thread/i);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('continues an oversized single source line without losing characters', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const source = 'x'.repeat(12_000);
    await fsPromises.writeFile(path.join(workspaceRootPath, 'src', 'large.ts'), source, 'utf8');

    try {
      const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ];
      const fragments: string[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await tool.execute({
          ...(cursor ? { cursor } : { path: '/src/large.ts' }),
          maxChars: 500,
        });
        expect(page.content).toMatch(/^1: x+$/);
        fragments.push(page.content.slice('1: '.length));
        cursor = page.nextCursor;
        if (!cursor) {
          break;
        }
      }

      expect(cursor).toBeNull();
      expect(fragments.join('')).toBe(source);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('reads a bounded page without calling the full-file reader', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const source = 'line\n'.repeat(380_000);
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'near-limit.txt'),
      source,
      'utf8'
    );
    const readFileSpy = vi.spyOn(fsPromises, 'readFile');

    try {
      const page = await buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ].execute({
        maxChars: 100,
        path: '/src/near-limit.txt',
      });

      expect(page.content.length).toBeLessThanOrEqual(100);
      expect(page.truncated).toBe(true);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('decodes a UTF-8 character split across handle-read chunks', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const source = `${'a'.repeat(65_534)}\n😀tail`;
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'chunk-boundary.txt'),
      source,
      'utf8'
    );

    try {
      const page = await buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
        'brainstrike.readWorkspaceFile'
      ].execute({
        maxChars: 100,
        path: '/src/chunk-boundary.txt',
        startLine: 2,
      });

      expect(page).toMatchObject({
        content: '2: 😀tail',
        endLine: 2,
        startLine: 2,
        totalLines: 2,
        truncated: false,
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedContent: '1: ',
      expectedTotalLines: 1,
      name: 'an empty file',
      source: '',
    },
    {
      expectedContent: '1: a\r\n2: b\r\n3: ',
      expectedTotalLines: 3,
      name: 'CRLF source with a trailing empty line',
      source: 'a\r\nb\r\n',
    },
  ])('preserves $name while scanning chunks', async ({
    expectedContent,
    expectedTotalLines,
    source,
  }) => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'line-shape.txt'),
      source,
      'utf8'
    );

    try {
      const page = await buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
        'brainstrike.readWorkspaceFile'
      ].execute({
        maxChars: 100,
        path: '/src/line-shape.txt',
      });

      expect(page).toMatchObject({
        content: expectedContent,
        omittedChars: 0,
        totalLines: expectedTotalLines,
        truncated: false,
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('does not mark a non-empty line as read when only its prefix fits', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'prefix-boundary.ts'),
      'a\nsecond',
      'utf8'
    );

    try {
      const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ];
      const first = await tool.execute({
        maxChars: 8,
        path: '/src/prefix-boundary.ts',
      });

      expect(first).toMatchObject({
        content: '1: a',
        endLine: 1,
        startLine: 1,
        truncated: true,
      });
      const continued = await tool.execute({
        cursor: first.nextCursor,
        maxChars: 8,
      });
      expect(continued.content).toBe('2: secon');
      expect(continued.startLine).toBe(2);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('counts the unread newline when continuation starts at the next line', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'newline-boundary.ts'),
      'a\nb',
      'utf8'
    );

    try {
      const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ];
      const first = await tool.execute({
        maxChars: 4,
        path: '/src/newline-boundary.ts',
      });

      expect(first).toMatchObject({
        content: '1: a',
        omittedChars: 2,
        truncated: true,
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it.each([
    { maxChars: 3, source: 'hello' },
    { maxChars: 4, source: '😀hello' },
  ])('rejects a page budget that cannot advance the source cursor ($maxChars chars)', async ({
    maxChars,
    source,
  }) => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'no-progress.ts'),
      source,
      'utf8'
    );

    try {
      const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ];

      await expect(
        tool.execute({
          maxChars,
          path: '/src/no-progress.ts',
        })
      ).rejects.toThrow(/cannot advance.*maxChars/i);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('rejects a continuation handle after the file changes', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    try {
      const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ];
      const first = await tool.execute({
        endLine: 4,
        maxChars: 10,
        path: '/src/main.ts',
        startLine: 1,
      });
      await fsPromises.writeFile(
        path.join(workspaceRootPath, 'src', 'main.ts'),
        'changed\nline 2\nline 3\nline 4',
        'utf8'
      );

      await expect(
        tool.execute({
          cursor: first.nextCursor,
          maxChars: 10,
        })
      ).rejects.toThrow(/continuation handle is stale/i);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
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
    expect(result.nextCursor).toBeNull();
    await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
  });

  it('treats provider-emitted null optional read args as omitted', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    try {
      const tools = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath));
      const tool = tools['brainstrike.readWorkspaceFile'];
      const result = await tool.execute({
        endLine: null,
        maxChars: null,
        path: '/src/main.ts',
        root: null,
        startLine: null,
      } as never);

      expect(result.path).toBe('/src/main.ts');
      expect(result.content).toContain('line 1');
      expect(result.truncated).toBe(false);
      expect(result.nextCursor).toBeNull();
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('keeps a default workspace file read inside the native result envelope', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'large.ts'),
      'x'.repeat(12_000),
      'utf8'
    );

    try {
      const tools = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath));
      const result = await tools['brainstrike.readWorkspaceFile'].execute({
        path: '/src/large.ts',
      });

      expect(JSON.stringify(result).length).toBeLessThanOrEqual(NATIVE_TOOL_RESULT_CHAR_BUDGET);
      expect(result.truncated).toBe(true);
      expect(result.omittedChars).toBe(12_000 - (result.content.length - '1: '.length));
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('preserves page metadata and nextCursor inside the model projection budget', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'src', 'large.ts'),
      'x'.repeat(12_000),
      'utf8'
    );

    try {
      const tool = buildDesktopAssistantTools(workspaceRuntime(workspaceRootPath))[
        'brainstrike.readWorkspaceFile'
      ] as {
        execute: (input: { path: string }) => Promise<Record<string, unknown>>;
        toModelOutput?: (output: unknown) => unknown;
      };
      const result = await tool.execute({ path: '/src/large.ts' });

      expect(tool.toModelOutput).toBeTypeOf('function');
      const projected = tool.toModelOutput?.(result);
      expect(projected).toEqual({ type: 'json', value: result });
      expect(JSON.stringify(projected).length).toBeLessThanOrEqual(
        MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
      );
      expect(result['truncated']).toBe(true);
      expect(result['nextCursor']).toEqual(expect.any(String));
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('fails visibly when read metadata alone exceeds the native result envelope', async () => {
    const workspaceRootPath = await createWorkspaceFixture();

    try {
      const tools = buildDesktopAssistantTools({
        workspaceRoots: [
          {
            displayName: 'r'.repeat(NATIVE_TOOL_RESULT_CHAR_BUDGET),
            path: workspaceRootPath,
            rootId: 'root-1',
          },
        ],
      } as RuntimeData);

      await expect(
        tools['brainstrike.readWorkspaceFile'].execute({
          path: '/src/main.ts',
        })
      ).rejects.toThrow(
        `readWorkspaceFile metadata exceeds the ${NATIVE_TOOL_RESULT_CHAR_BUDGET}-character native result budget`
      );
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
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

  it('re-resolves a symlink after waiting for its original target lock', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const firstTarget = path.join(workspaceRootPath, 'src', 'first-target.txt');
    const secondTarget = path.join(workspaceRootPath, 'src', 'second-target.txt');
    const linkedFile = path.join(workspaceRootPath, 'src', 'retargeted.txt');
    await fsPromises.writeFile(firstTarget, 'first target', 'utf8');
    await fsPromises.writeFile(secondTarget, 'second target', 'utf8');

    try {
      try {
        await fsPromises.symlink(firstTarget, linkedFile, 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') {
          return;
        }
        throw error;
      }

      let releaseLock: () => void = () => {
        throw new Error('release not armed');
      };
      const holdLock = withFileLock(
        realpathSync(firstTarget),
        () =>
          new Promise<void>((resolve) => {
            releaseLock = resolve;
          })
      );
      const readPromise = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
        'brainstrike.readWorkspaceFile'
      ].execute({ path: '/src/retargeted.txt' });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await fsPromises.unlink(linkedFile);
      await fsPromises.symlink(secondTarget, linkedFile, 'file');
      releaseLock();
      await holdLock;

      await expect(readPromise).resolves.toMatchObject({
        content: '1: second target',
        path: '/src/retargeted.txt',
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
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

  it('registers compact grep and glob projections without mutating their raw results', () => {
    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);
    const grepRaw = {
      candidatesTruncated: false,
      files: [
        {
          firstLine: 11,
          matchCount: 1,
          path: '/src/x.ts',
          rootId: 'root-a',
          rootName: 'alpha',
          source: 'both',
        },
      ],
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 1,
      totalMatches: 1,
      truncated: false,
    };
    const globRaw = {
      count: 1,
      matches: [{ path: '/src/x.ts', rootId: 'root-a', rootName: 'alpha' }],
      offset: 0,
      scanLimited: false,
      totalMatches: 1,
      truncated: false,
    };
    const grepBefore = structuredClone(grepRaw);
    const globBefore = structuredClone(globRaw);

    expect(tools['brainstrike.grepSearch'].toModelOutput?.(grepRaw)).toEqual({
      type: 'text',
      value: [
        'grep files | page=1-1/1 | matches=1 | live=ripgrep | candidates_truncated=false | scan_limited=false',
        'read_args={"path":"/src/x.ts","root":"root-a","startLine":11} | root_name="alpha" | matches=1 | source=both',
      ].join('\n'),
    });
    expect(tools['brainstrike.globWorkspace'].toModelOutput?.(globRaw)).toEqual({
      type: 'text',
      value: [
        'glob | page=1-1/1 | scan_limited=false',
        'read_args={"path":"/src/x.ts","root":"root-a"} | root_name="alpha"',
      ].join('\n'),
    });
    expect(grepRaw).toEqual(grepBefore);
    expect(globRaw).toEqual(globBefore);
  });

  it('hands grep read_args directly into an exact read in a multi-root workspace', async () => {
    const rootA = await createWorkspaceFixture();
    const rootB = await createWorkspaceFixture();
    const tools = buildDesktopAssistantTools({
      memory: { resourceId: 'workspace', threadId: 'thread-multi-root-handoff' },
      workspaceRoots: [
        { displayName: 'alpha', path: rootA, rootId: 'root-a' },
        { displayName: 'beta', path: rootB, rootId: 'root-b' },
      ],
    } as RuntimeData);

    try {
      const projected = tools['brainstrike.grepSearch'].toModelOutput?.({
        candidatesTruncated: false,
        files: [
          {
            firstLine: 2,
            matchCount: 1,
            path: '/src/main.ts',
            rootId: 'root-b',
            rootName: 'beta',
            source: 'both',
          },
        ],
        liveEngine: 'ripgrep',
        offset: 0,
        outputMode: 'files',
        scanLimited: false,
        totalFiles: 1,
        totalMatches: 1,
        truncated: false,
      });
      expect(projected?.type).toBe('text');
      const match = projected?.value.match(/read_args=(\{.*\}) \| root_name=/u);
      expect(match?.[1]).toBeDefined();
      const readInput = NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.readWorkspaceFile'].parse(
        JSON.parse(match?.[1] ?? '')
      );

      await expect(
        tools['brainstrike.readWorkspaceFile'].execute(readInput)
      ).resolves.toMatchObject({
        content: '2: line 2\n3: line 3\n4: line 4',
        path: '/src/main.ts',
        startLine: 2,
      });
      await expect(
        tools['brainstrike.readWorkspaceFile'].execute({ path: '/src/main.ts', root: null })
      ).rejects.toThrow(ToolInputError);
    } finally {
      await Promise.all([
        fsPromises.rm(rootA, { force: true, recursive: true }),
        fsPromises.rm(rootB, { force: true, recursive: true }),
      ]);
    }
  });

  it('registers compact symbol and LSP projections without mutating raw results', () => {
    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);
    const symbolRaw = {
      matches: [
        {
          declarationLine: 7,
          endLine: 12,
          name: 'export function target() {',
          preview: '7: export function target() {',
          startLine: 7,
        },
      ],
      path: '/src/target.ts',
      rootName: 'workspace',
      totalMatches: 1,
      truncated: false,
    };
    const lspRaw = {
      available: true,
      hover: 'function target(): void',
      language: 'typescript',
      path: '/src/target.ts',
      rootName: 'workspace',
    };
    const symbolBefore = structuredClone(symbolRaw);
    const lspBefore = structuredClone(lspRaw);

    expect(tools['brainstrike.findWorkspaceSymbol'].toModelOutput?.(symbolRaw)).toMatchObject({
      type: 'text',
    });
    expect(tools['brainstrike.findWorkspaceSymbol'].toModelOutput?.(symbolRaw).value).toContain(
      'inspect: call brainstrike.lspInspect'
    );
    expect(tools['brainstrike.lspInspect'].toModelOutput?.(lspRaw)).toEqual({
      type: 'text',
      value:
        'lsp | available=true | root=workspace | path=/src/target.ts | language=typescript\nhover: function target(): void',
    });
    expect(symbolRaw).toEqual(symbolBefore);
    expect(lspRaw).toEqual(lspBefore);
  });

  it('registers compact workspace-context projection without mutating the raw result', () => {
    const tool = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData)['brainstrike.listWorkspaceContext'];
    const raw = {
      offset: 0,
      selectedFileCount: 1,
      selectedFiles: ['/src/target.ts'],
      truncated: false,
      workspaceIndex: {
        embeddingSetId: 'workspace-index',
        enabled: true,
        mode: 'root-folder-cache',
        paused: false,
      },
      workspaceRootPath: '/tmp/workspace',
      workspaceRoots: [
        {
          displayName: 'workspace',
          path: '/tmp/workspace',
          rootId: 'root-a',
        },
      ],
    };
    const before = structuredClone(raw);

    expect(tool.toModelOutput?.(raw)).toEqual({
      type: 'text',
      value: [
        'workspace context | main=/tmp/workspace | selected=1 | outside=0 | page=1-1/1 | truncated=false',
        'index | enabled=true | paused=false | mode=root-folder-cache | embedding_set=workspace-index',
        'root main | name=workspace | id=root-a | path=/tmp/workspace',
        'selected /src/target.ts',
      ].join('\n'),
    });
    expect(raw).toEqual(before);
  });

  it('registers compact semantic and hybrid projections without mutating raw results', () => {
    const tools = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData);
    const semanticRaw = {
      budget: 4000,
      chunkContentIncludedInContext: false,
      chunks: [],
      context: '',
      embeddingSetId: 'workspace-index',
      limit: 20,
      query: 'assistant registry',
      remainingTokens: 4000,
      skipped: 0,
      skippedForMissingSourceRange: 0,
      skippedSourceRangeChunks: [],
      threshold: 0.3,
      totalTokens: 0,
    };
    const hybridRaw = {
      embeddingSetId: 'workspace-index',
      ftsWeight: 1,
      limit: 20,
      metadata: {
        ftsResultCount: 0,
        fusedResultCount: 0,
        totalMs: 2,
        vectorResultCount: 0,
      },
      query: 'assistant registry',
      results: [],
      truncated: false,
      vectorWeight: 1,
    };
    const semanticBefore = structuredClone(semanticRaw);
    const hybridBefore = structuredClone(hybridRaw);

    expect(tools['brainstrike.queryEmbeddingSpace'].toModelOutput?.(semanticRaw)).toMatchObject({
      type: 'text',
    });
    expect(tools['brainstrike.hybridSearch'].toModelOutput?.(hybridRaw)).toMatchObject({
      type: 'text',
    });
    expect(semanticRaw).toEqual(semanticBefore);
    expect(hybridRaw).toEqual(hybridBefore);
  });

  it('registers a compact web-search projection without mutating the raw result', () => {
    const tool = buildDesktopAssistantTools({
      workspaceRootPath: '/tmp/workspace',
    } as RuntimeData)['brainstrike.webSearch'];
    const raw = {
      available: true,
      count: 1,
      query: 'current Mastra docs',
      results: [
        {
          snippet: 'Current tool documentation.',
          title: 'Mastra tools',
          url: 'https://mastra.ai/docs/agents/using-tools',
        },
      ],
      totalResults: 1,
      truncated: false,
    };
    const before = structuredClone(raw);

    expect(tool.toModelOutput?.(raw)).toEqual({
      type: 'text',
      value: [
        'web-search | status=available | shown=1/1 | truncated=false',
        'query: "current Mastra docs"',
        '#1 title: Mastra tools',
        'url: "https://mastra.ai/docs/agents/using-tools"',
        'snippet: Current tool documentation.',
      ].join('\n'),
    });
    expect(raw).toEqual(before);
  });

  it('keeps webExtract execute output rich while registering its complete inline projection', async () => {
    const content = '# Exact source\n\nUnicode 雪 and `"quotes"`.';
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            failed_results: [],
            results: [
              {
                raw_content: content,
                url: 'https://example.com/exact',
              },
            ],
          }),
          { status: 200 }
        )
      )
    ) as typeof fetch;
    const tool = buildDesktopAssistantTools(
      { workspaceRootPath: '/tmp/workspace' } as RuntimeData,
      {
        webExtract: {
          fetchImpl,
          resolveApiKey: async () => 'tvly-test-key',
        },
      }
    )['brainstrike.webExtract'];

    const raw = await tool.execute({
      context: { urls: ['https://example.com/exact'] },
    });

    expect(raw.results).toEqual([{ content, url: 'https://example.com/exact' }]);
    expect(tool.toModelOutput?.(raw)).toMatchObject({
      type: 'text',
      value: expect.stringContaining(`content_json: ${JSON.stringify(content)}`),
    });
    expect(raw.results[0]?.content).toBe(content);
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

  it('registers compact workspace-scoped inspect and manage command-session tools', async () => {
    const session = {
      createdAt: 100,
      cwd: '/workspace/api',
      id: 'session-1',
      pid: 4242,
      rootId: 'db-root-api',
      status: 'running' as const,
    };
    const manager = {
      dispose: vi.fn(async () => 0),
      disposeRoot: vi.fn(async () => 0),
      get: vi.fn(() => session),
      list: vi.fn(() => [session]),
      read: vi.fn(() => ({
        bufferStartCursor: 0,
        hasMore: false,
        nextCursor: 5,
        output: 'ready',
        requestedCursor: 0,
        truncatedBeforeCursor: false,
      })),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => session),
      stop: vi.fn(async () => undefined),
      write: vi.fn(),
    } satisfies CommandSessionManager;
    const runtime = {
      workspaceRoots: [
        { displayName: 'api', path: '/workspace/api', rootId: 'db-root-api' },
        { displayName: 'web', path: '/workspace/web', rootId: 'db-root-web' },
      ],
    } as RuntimeData;
    const tools = buildDesktopAssistantTools(runtime, { commandSessionManager: manager });
    const abortController = new AbortController();

    expect(
      tools['brainstrike.inspectCommandSessions'].execute({
        operation: { action: 'list' },
        root: 'api',
      })
    ).toEqual({
      offset: 0,
      rootId: 'db-root-api',
      sessions: [session],
      totalSessions: 1,
      truncated: false,
    });
    expect(
      tools['brainstrike.inspectCommandSessions'].execute({
        operation: { action: 'read', cursor: 0, sessionId: 'session-1' },
        root: 'api',
      })
    ).toMatchObject({ nextCursor: 5, output: 'ready', session });
    await expect(
      tools['brainstrike.manageCommandSession'].execute(
        {
          operation: { action: 'start', command: 'pnpm dev' },
          root: 'api',
        },
        { abortSignal: abortController.signal }
      )
    ).resolves.toEqual(session);
    await tools['brainstrike.manageCommandSession'].execute({
      operation: { action: 'write', data: 'q\n', sessionId: 'session-1' },
      root: 'api',
    });
    await tools['brainstrike.manageCommandSession'].execute({
      operation: { action: 'stop', sessionId: 'session-1' },
      root: 'api',
    });
    await tools['brainstrike.manageCommandSession'].execute({
      operation: { action: 'remove', sessionId: 'session-1' },
      root: 'api',
    });

    expect(manager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'pnpm dev',
        rootId: 'db-root-api',
        signal: abortController.signal,
      })
    );
    expect(manager.write).toHaveBeenCalledWith('db-root-api', 'session-1', 'q\n');
    expect(manager.stop).toHaveBeenCalledWith('db-root-api', 'session-1');
    expect(manager.remove).toHaveBeenCalledWith('db-root-api', 'session-1');
  });

  it('keeps command-session secrets out of the durable transcript', async () => {
    const session = {
      createdAt: 100,
      cwd: '/workspace/api/private',
      id: 'session-1',
      pid: 4242,
      rootId: 'db-root-api',
      status: 'running' as const,
    };
    const manager = {
      dispose: vi.fn(async () => 0),
      disposeRoot: vi.fn(async () => 0),
      get: vi.fn(() => session),
      list: vi.fn(() => [session]),
      read: vi.fn(() => ({
        bufferStartCursor: 0,
        hasMore: false,
        nextCursor: 18,
        output: 'TOKEN=secret-value',
        requestedCursor: 0,
        truncatedBeforeCursor: false,
      })),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => session),
      stop: vi.fn(async () => undefined),
      write: vi.fn(),
    } satisfies CommandSessionManager;
    const runtime = {
      workspaceRoots: [{ displayName: 'api', path: '/workspace/api', rootId: 'db-root-api' }],
    } as RuntimeData;
    const tools = buildDesktopAssistantTools(runtime, { commandSessionManager: manager });
    const inspectTransform = (
      tools['brainstrike.inspectCommandSessions'] as { transform?: CommandSessionPayloadTransform }
    ).transform?.transcript;
    const manageTransform = (
      tools['brainstrike.manageCommandSession'] as { transform?: CommandSessionPayloadTransform }
    ).transform?.transcript;

    expect(inspectTransform?.output).toBeTypeOf('function');
    expect(manageTransform?.input).toBeTypeOf('function');
    expect(manageTransform?.output).toBeTypeOf('function');

    const persistedStartInput = await manageTransform?.input?.({
      input: {
        operation: {
          action: 'start',
          command: 'AUTH_TOKEN=secret-value pnpm dev',
          cwd: '/workspace/api/private',
        },
        root: 'api',
      },
      phase: 'input-available',
      target: 'transcript',
      toolCallId: 'call-start',
      toolName: 'brainstrike.manageCommandSession',
    });
    const persistedWriteInput = await manageTransform?.input?.({
      input: {
        operation: { action: 'write', data: 'secret-password\n', sessionId: 'session-1' },
        root: 'api',
      },
      phase: 'input-available',
      target: 'transcript',
      toolCallId: 'call-write',
      toolName: 'brainstrike.manageCommandSession',
    });
    const persistedReadOutput = await inspectTransform?.output?.({
      output: {
        bufferStartCursor: 0,
        nextCursor: 18,
        output: 'TOKEN=secret-value',
        requestedCursor: 0,
        session,
        truncatedBeforeCursor: false,
      },
      phase: 'output-available',
      target: 'transcript',
      toolCallId: 'call-read',
      toolName: 'brainstrike.inspectCommandSessions',
    });
    const persistedManageOutput = await manageTransform?.output?.({
      output: session,
      phase: 'output-available',
      target: 'transcript',
      toolCallId: 'call-start',
      toolName: 'brainstrike.manageCommandSession',
    });
    const persistedHookBlock = await manageTransform?.output?.({
      output: {
        error: {
          code: 'tool_blocked_by_hook',
          message: 'Blocked command: AUTH_TOKEN=secret-value pnpm dev',
          toolName: 'brainstrike.manageCommandSession',
        },
        ok: false,
        reason: 'Rejected cwd /workspace/api/private',
      },
      phase: 'output-available',
      target: 'transcript',
      toolCallId: 'call-blocked',
      toolName: 'brainstrike.manageCommandSession',
    });
    const serialized = JSON.stringify({
      persistedHookBlock,
      persistedManageOutput,
      persistedReadOutput,
      persistedStartInput,
      persistedWriteInput,
    });

    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('secret-password');
    expect(serialized).not.toContain('/workspace/api/private');
    expect(persistedStartInput).toMatchObject({
      operation: { action: 'start', redactedFields: ['command', 'cwd'] },
      root: 'api',
    });
    expect(persistedWriteInput).toMatchObject({
      operation: {
        action: 'write',
        redactedFields: ['data'],
        sessionId: 'session-1',
        writtenUtf16CodeUnits: 16,
      },
      root: 'api',
    });
    expect(persistedReadOutput).toMatchObject({
      nextCursor: 18,
      outputRedacted: true,
      outputUtf16CodeUnits: 18,
      session: { id: 'session-1', rootId: 'db-root-api' },
    });
    expect(persistedManageOutput).toMatchObject({
      id: 'session-1',
      rootId: 'db-root-api',
      status: 'running',
    });
    expect(persistedHookBlock).toEqual({
      error: {
        code: 'tool_blocked_by_hook',
        message: 'Command-session tool failure details redacted.',
        toolName: 'brainstrike.manageCommandSession',
      },
      ok: false,
    });
  });

  it('pages command-session inventory and output below the durable artifact threshold', () => {
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      createdAt: index,
      cwd: `/workspace/api/${'nested/'.repeat(20)}session-${index}`,
      id: `session-${index}`,
      pid: 4000 + index,
      rootId: 'db-root-api',
      status: 'running' as const,
    }));
    const output = `${'😀 secret-output '.repeat(2000)}tail`;
    const manager = {
      dispose: vi.fn(async () => 0),
      disposeRoot: vi.fn(async () => 0),
      get: vi.fn(() => sessions[0]!),
      list: vi.fn(() => sessions),
      read: vi.fn(
        (_rootId: string, _sessionId: string, cursor = 0, maxUtf16CodeUnits = output.length) => {
          const requestedEnd = Math.min(output.length, cursor + maxUtf16CodeUnits);
          const endsOnHighSurrogate =
            output.charCodeAt(requestedEnd - 1) >= 0xd8_00 &&
            output.charCodeAt(requestedEnd - 1) <= 0xdb_ff;
          const end = endsOnHighSurrogate ? requestedEnd - 1 : requestedEnd;
          return {
            bufferStartCursor: 0,
            hasMore: end < output.length,
            nextCursor: end,
            output: cursor === -1 ? '' : output.slice(cursor, end),
            requestedCursor: cursor,
            truncatedBeforeCursor: false,
          };
        }
      ),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => sessions[0]!),
      stop: vi.fn(async () => undefined),
      write: vi.fn(),
    } satisfies CommandSessionManager;
    const runtime = {
      workspaceRoots: [{ displayName: 'api', path: '/workspace/api', rootId: 'db-root-api' }],
    } as RuntimeData;
    const tools = buildDesktopAssistantTools(runtime, { commandSessionManager: manager });
    const inspect = tools['brainstrike.inspectCommandSessions'];

    const listedSessionIds: string[] = [];
    let offset = 0;
    while (offset < sessions.length) {
      const page = inspect.execute({
        operation: { action: 'list', offset },
        root: 'api',
      });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(
        COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES
      );
      expect(page).toMatchObject({
        offset,
        rootId: 'db-root-api',
        totalSessions: 100,
      });
      expect(page.sessions.length).toBeGreaterThan(0);
      listedSessionIds.push(...page.sessions.map((session) => session.id));
      if (!page.truncated) {
        break;
      }
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(listedSessionIds).toEqual(sessions.map((session) => session.id));

    let rebuiltOutput = '';
    let cursor = 0;
    while (cursor < output.length) {
      const page = inspect.execute({
        operation: { action: 'read', cursor, sessionId: 'session-0' },
        root: 'api',
      });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(
        COMMAND_SESSION_TOOL_RESULT_MAX_UTF8_BYTES
      );
      expect(page.availableEndCursor).toBeLessThanOrEqual(output.length);
      expect(page.availableEndCursor).toBeGreaterThanOrEqual(page.nextCursor);
      expect(page.nextCursor).toBe(cursor + page.output.length);
      expect(page.nextCursor).toBeGreaterThan(cursor);
      expect(page.hasMore).toBe(page.nextCursor < output.length);
      expect(page.remainingUtf16CodeUnits).toBe(page.availableEndCursor - page.nextCursor);
      expect(page.output.endsWith('\ud83d')).toBe(false);
      rebuiltOutput += page.output;
      cursor = page.nextCursor;
    }
    expect(rebuiltOutput).toBe(output);
  });

  it('registers the artifact reader only with a trusted scoped read capability', async () => {
    const content = new TextEncoder().encode('artifact content');
    const artifactRef: ToolOutputArtifactReference = {
      byteLength: content.byteLength,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      format: 'text',
      id: 'artifact-id',
    };
    expect(
      buildDesktopAssistantTools({
        provider: 'openai',
      } as RuntimeData)['brainstrike.readToolOutputArtifact']
    ).toBeUndefined();

    const readRange = vi.fn(async ({ limitBytes, offsetByte }) => {
      const bytes = content.slice(offsetByte, offsetByte + limitBytes);
      return {
        bytes,
        endByte: offsetByte + bytes.byteLength,
        offsetByte,
        reference: artifactRef,
        status: 'found' as const,
      };
    });
    const tool = buildDesktopAssistantTools({ provider: 'openai' } as RuntimeData, {
      toolOutputArtifactReader: { readRange },
    })['brainstrike.readToolOutputArtifact'];

    const page = await tool.execute({
      cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
      maxBytes: 8,
    });
    expect(page).toMatchObject({
      artifactRef,
      content: 'artifact',
      endByte: 8,
      offsetByte: 0,
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(readRange).toHaveBeenCalledWith({
      artifactId: artifactRef.id,
      limitBytes: 8,
      offsetByte: 0,
    });
    const projection = tool.toModelOutput(page);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    if (!projection.value.next) {
      throw new TypeError('Expected an artifact continuation call.');
    }
    expect(projection.value.next.tool).toBe('brainstrike.readToolOutputArtifact');

    const finalPage = await tool.execute(projection.value.next.input);
    expect(`${page.content}${finalPage.content}`).toBe('artifact content');
    expect(finalPage.nextCursor).toBeUndefined();
    expect(tool.toModelOutput(finalPage).value.complete).toBe(true);
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

  it('returns an explicit empty workspace context when root resolution completed with zero roots', async () => {
    const tool = buildDesktopAssistantTools({
      provider: 'openai',
      workspaceRoots: [],
    } as RuntimeData)['brainstrike.listWorkspaceContext'];

    await expect(tool.execute({ context: {} })).resolves.toEqual({
      offset: 0,
      selectedFileCount: 0,
      selectedFiles: [],
      selectionFolderId: null,
      truncated: false,
      workspaceIndex: {
        embeddingSetId: null,
        enabled: false,
        mode: null,
        paused: false,
      },
      workspaceRootPath: null,
      workspaceRoots: [],
    });
  });

  it('still fails when root resolution did not produce an authoritative result', async () => {
    const tool = buildDesktopAssistantTools({
      provider: 'openai',
    } as RuntimeData)['brainstrike.listWorkspaceContext'];

    await expect(tool.execute({ context: {} })).rejects.toThrow(/no folder is open/i);
  });

  it('still fails when resolved root metadata is malformed', async () => {
    const tool = buildDesktopAssistantTools({
      provider: 'openai',
      workspaceRoots: [{ displayName: 'broken', path: 'relative', rootId: 'root-broken' }],
    } as unknown as RuntimeData)['brainstrike.listWorkspaceContext'];

    await expect(tool.execute({ context: {} })).rejects.toThrow(/root metadata is malformed/i);
  });

  it('fails when zero roots retain a selection count from other roots', async () => {
    const tool = buildDesktopAssistantTools({
      provider: 'openai',
      selectionFilePathsFromOtherRoots: 1,
      workspaceRoots: [],
    } as RuntimeData)['brainstrike.listWorkspaceContext'];

    await expect(tool.execute({ context: {} })).rejects.toThrow(/root metadata is inconsistent/i);
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
    const openSpy = vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(readError);
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
      openSpy.mockRestore();
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

    it('keeps selected-context defaults in the focused root when the thread is bound elsewhere', async () => {
      const { rootA, rootB, cleanup } = await createTwoRootContext();
      try {
        const tools = buildDesktopAssistantTools({
          ...twoRootRuntime(rootA, rootB),
          boundWorkspaceRootId: 'id-a',
          selectionFilePaths: ['/notes.md'],
          workspaceRootPath: rootB,
        } as RuntimeData);
        const result = await tools['brainstrike.readWorkspaceContext'].execute({ context: {} });

        expect(result.rootId).toBe('id-b');
        expect(result.rootName).toBe('ProjectB');
        expect(result.files[0]?.content).toContain('beta root');

        const explicitPaths = await tools['brainstrike.readWorkspaceContext'].execute({
          context: { filePaths: ['/notes.md'] },
        });
        expect(explicitPaths.rootId).toBe('id-a');
        expect(explicitPaths.files[0]?.content).toContain('alpha root');
      } finally {
        await cleanup();
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
});
