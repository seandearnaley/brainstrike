import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_DEFAULTS, NATIVE_TOOL_INPUT_SCHEMAS } from '@brainstrike/agent';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  NATIVE_TOOL_ID,
  TOOL_DESCRIPTIONS,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { disposeLspServers } from '../../assistant-server/lsp-diagnostics';
import { requireTool, requireToolExecute, singleRootRuntime } from './_tool-test-helpers';

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
vi.mock('@brainstrike/db/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db/react')>();
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

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
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
describe('assistant-tools multi-root read tools', () => {
  beforeEach(() => {
    resetToolCallLoopGuards();
  });

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
      memory: { resourceId: 'multi-root-workspace', threadId: 'multi-root-thread' },
      workspaceRoots: [
        { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
        { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
      ],
    } as RuntimeData;
  }

  it('keeps omitted read/write/replace/cursor calls inside the durable thread root', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const runtime = {
        ...twoRootRuntime(rootA, rootB),
        boundWorkspaceRootId: 'id-b',
      } as RuntimeData;
      const tools = buildDesktopAssistantTools(runtime);
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeReplaceTool = requireToolExecute(
        tools,
        'brainstrike.stringReplaceWorkspaceFile'
      );
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

      const first = await executeReadTool({
        maxChars: 14,
        path: '/README.md',
      });
      expect(first.rootName).toBe('ProjectB');
      expect(first.content).toContain('Project B');

      const continued = await executeReadTool({
        cursor: first.nextCursor,
        maxChars: 40,
      });
      expect(continued.rootName).toBe('ProjectB');

      const replaced = await executeReplaceTool({
        newStr: '# Bound Project B',
        oldStr: '# Project B',
        path: '/README.md',
      });
      expect(replaced.rootName).toBe('ProjectB');
      expect(replaced.rootId).toBe('id-b');

      const written = await executeWriteTool({
        content: 'bound',
        path: '/bound.txt',
      });
      expect(written.rootName).toBe('ProjectB');
      expect(written.rootId).toBe('id-b');
      expect(await fsPromises.readFile(path.join(rootB, 'bound.txt'), 'utf8')).toBe('bound');
      await expect(fsPromises.access(path.join(rootA, 'bound.txt'))).rejects.toThrow();

      const explicitCrossRoot = await executeReadTool({
        path: '/README.md',
        root: 'id-a',
      });
      expect(explicitCrossRoot.rootName).toBe('ProjectA');
    } finally {
      await cleanup();
    }
  });

  it('reads the file from the root named by `root` and labels the result', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );

      const fromB = await executeTool({ path: '/README.md', root: 'ProjectB' });
      expect(fromB.rootName).toBe('ProjectB');
      expect(fromB.content).toContain('Project B');

      const fromA = await executeTool({ path: '/README.md', root: 'ProjectA' });
      expect(fromA.rootName).toBe('ProjectA');
      expect(fromA.content).toContain('Project A');
    } finally {
      await cleanup();
    }
  });

  it('rejects an attempt to override the root bound to a continuation handle', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    const fixedMtime = new Date('2026-01-01T00:00:00.000Z');
    await fsPromises.writeFile(path.join(rootA, 'same.txt'), 'aaaaaaaaaaaaaaaa', 'utf8');
    await fsPromises.writeFile(path.join(rootB, 'same.txt'), 'bbbbbbbbbbbbbbbb', 'utf8');
    await fsPromises.utimes(path.join(rootA, 'same.txt'), fixedMtime, fixedMtime);
    await fsPromises.utimes(path.join(rootB, 'same.txt'), fixedMtime, fixedMtime);

    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );
      const first = await executeTool({
        maxChars: 10,
        path: '/same.txt',
        root: 'id-a',
      });

      await expect(
        executeTool({
          cursor: first.nextCursor,
          maxChars: 10,
          root: 'id-b',
        })
      ).rejects.toThrow(/omit root when continuing with cursor/i);
    } finally {
      await cleanup();
    }
  });

  it('resolves an omitted continuation root from the cursor in a multi-root workspace', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();

    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );
      const first = await executeTool({
        maxChars: 14,
        path: '/README.md',
        root: 'id-a',
      });

      const continued = await executeTool({
        cursor: first.nextCursor,
        maxChars: 40,
      });

      expect(continued.rootName).toBe('ProjectA');
      expect(continued.content).toContain('export const fromA');
    } finally {
      await cleanup();
    }
  });

  it('keeps continuation identity local and rejects path overrides or changed ranges', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    await fsPromises.writeFile(
      path.join(rootA, 'replayed-range.txt'),
      Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'),
      'utf8'
    );

    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );
      const first = await executeTool({
        endLine: 80,
        maxChars: 30,
        path: '/replayed-range.txt',
        root: 'id-a',
        startLine: 1,
      });

      await expect(
        executeTool({
          cursor: first.nextCursor,
          endLine: 81,
          maxChars: 30,
        } as never)
      ).rejects.toThrow(/original startLine\/endLine unchanged/i);

      const continued = await executeTool({ cursor: first.nextCursor, maxChars: 30 });

      expect(continued.rootName).toBe('ProjectA');
      expect(continued.startLine).toBeGreaterThan(1);
      expect(continued.content).toMatch(/^\d+: /);
    } finally {
      await cleanup();
    }
  });

  it('keeps continuation handles valid when tools are rebuilt after a renderer reload', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    await fsPromises.writeFile(
      path.join(rootA, 'default-range.txt'),
      Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'),
      'utf8'
    );

    try {
      const runtime = twoRootRuntime(rootA, rootB);
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(runtime),
        'brainstrike.readWorkspaceFile'
      );
      const first = await executeTool({
        maxChars: 30,
        path: '/default-range.txt',
        root: 'id-a',
      });

      const executeRebuiltTool = requireToolExecute(
        buildDesktopAssistantTools(runtime),
        'brainstrike.readWorkspaceFile'
      );
      const continued = await executeRebuiltTool({ cursor: first.nextCursor, maxChars: 30 });

      expect(continued.rootName).toBe('ProjectA');
      expect(continued.startLine).toBeGreaterThan(1);
      expect(continued.content).toMatch(/^\d+: /);
    } finally {
      await cleanup();
    }
  });

  it('resolves `root` by id as well as by display name', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );
      const result = await executeTool({ path: '/README.md', root: 'id-b' });
      expect(result.content).toContain('Project B');
    } finally {
      await cleanup();
    }
  });

  it('errors and lists the open folders when `root` is omitted and several are open', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );
      await expect(executeTool({ path: '/README.md' })).rejects.toThrow(
        /multiple folders.*ProjectA.*ProjectB/is
      );
    } finally {
      await cleanup();
    }
  });

  it('errors with the available folders for an unknown `root`', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceFile'
      );
      await expect(executeTool({ path: '/README.md', root: 'Nope' })).rejects.toThrow(
        /no folder "Nope".*ProjectA.*ProjectB/is
      );
    } finally {
      await cleanup();
    }
  });

  it('lists a directory from the chosen root and labels it', async () => {
    const { rootA, rootB, cleanup } = await createTwoRootWorkspace();
    try {
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.readWorkspaceDirectory'
      );
      const result = await executeTool({ path: '/', root: 'ProjectA' });
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
      const executeTool = requireToolExecute(
        buildDesktopAssistantTools(twoRootRuntime(rootA, rootB)),
        'brainstrike.findWorkspaceSymbol'
      );
      const result = await executeTool({ path: '/README.md', query: 'fromB', root: 'ProjectB' });
      expect(result.rootName).toBe('ProjectB');
      expect(result.totalMatches).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  describe('tool registry and risk catalog', () => {
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
        const tool = requireTool(tools, toolId) as {
          description?: string;
          id?: string;
          inputSchema?: unknown;
        };
        expect(tool.id).toBe(toolId);
        expect(tool.description).toBe(TOOL_DESCRIPTIONS[toolId]);
        expect(tool.inputSchema).toBe(NATIVE_TOOL_INPUT_SCHEMAS[toolId]);
      }
    });
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

  describe('worktree tool provider gating', () => {
    it('omits both worktree tools for the built-in local provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'local' } as RuntimeData);

      expect(Object.hasOwn(tools, NATIVE_TOOL_ID.listWorktrees)).toBe(false);
      expect(Object.hasOwn(tools, NATIVE_TOOL_ID.manageWorktree)).toBe(false);
      // Falsifier: the gate must not have swallowed its neighbours either.
      expect(Object.hasOwn(tools, NATIVE_TOOL_ID.readWorkspaceFile)).toBe(true);
    });

    it('registers both worktree tools for a hosted provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'openai' } as RuntimeData);

      expect(Object.hasOwn(tools, NATIVE_TOOL_ID.listWorktrees)).toBe(true);
      expect(Object.hasOwn(tools, NATIVE_TOOL_ID.manageWorktree)).toBe(true);
    });
  });

  describe('command-session provider gating', () => {
    it('registers both session tools for a hosted provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'anthropic' } as RuntimeData);
      expect(tools['brainstrike.inspectCommandSessions']).toBeDefined();
      expect(tools['brainstrike.manageCommandSession']).toBeDefined();
    });

    it('omits both session tools for the built-in local provider', () => {
      const tools = buildDesktopAssistantTools({ provider: 'local' } as RuntimeData);
      expect(tools['brainstrike.inspectCommandSessions']).toBeUndefined();
      expect(tools['brainstrike.manageCommandSession']).toBeUndefined();
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

    it('rejects unknown enabled tool ids instead of silently filtering them', () => {
      expect(() =>
        buildDesktopAssistantTools({
          enabledNativeToolIds: ['brainstrike.readWorkspaceFile', 'brainstrike.removedNativeTool'],
          provider: 'local',
        } as RuntimeData)
      ).toThrow('Enabled native tool preferences contain unknown tool IDs.');
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

    function lspRuntime(workspaceRootPath: string, threadId: string): RuntimeData {
      return {
        ...singleRootRuntime(workspaceRootPath),
        memory: { resourceId: 'r', runId: 'run', threadId },
      } as RuntimeData;
    }

    it('attaches diagnostics to a stringReplace that introduces a type error', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'typed.ts'),
          'export const value: number = 1;\n',
          'utf8'
        );

        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-thread'));
        const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
        const executeReplaceTool = requireToolExecute(
          tools,
          'brainstrike.stringReplaceWorkspaceFile'
        );
        // Read first so the R8 staleness guard has a fresh observation.
        await executeReadTool({
          context: { path: '/src/typed.ts' },
        });

        const result = await executeReplaceTool({
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
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-thread-2'));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        const result = await executeTool({
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
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-inspect'));
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        const result = await executeTool({
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
        const tools = buildDesktopAssistantTools(
          lspRuntime(workspaceRootPath, 'lsp-inspect-fragment')
        );
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        // A fragment of line 2 (not the full line): the cursor column must be
        // fragment-start-in-line + marker-offset-in-fragment, pointing at the
        // SECOND `greeting`. Raw indexOf on the fragment would yield column 3
        // (mid-"export") and silently inspect nothing.
        const result = await executeTool({
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

    it('lspInspect accepts a unique markerless identifier at its first character', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'sym.ts'),
          'export const greeting: string = "hi";\nexport const echo = greeting;\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-markerless'));
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        const result = await executeTool({
          context: { line: 2, match: 'greeting', path: '/src/sym.ts' },
        });

        expect(result.available).toBe(true);
        expect(result.hover).toMatch(/string/);
        expect(result.definition?.[0]?.line).toBe(1);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect tells repeated markerless identifiers to use an explicit cursor marker', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'sym.ts'),
          'export const greeting = greeting;\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools(
          lspRuntime(workspaceRootPath, 'lsp-markerless-repeated')
        );
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        await expect(
          executeTool({
            context: { line: 1, match: 'greeting', path: '/src/sym.ts' },
          })
        ).rejects.toThrow(/pass a unique line fragment with exactly one "<<<"/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect does not match a markerless identifier inside a longer identifier', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'sym.ts'),
          'export const greetingSuffix = 1;\nexport const greeting: string = "hi";\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools(
          lspRuntime(workspaceRootPath, 'lsp-markerless-boundary')
        );
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        await expect(
          executeTool({
            context: { line: 1, match: 'greeting', path: '/src/sym.ts' },
          })
        ).rejects.toThrow(/identifier occurs on line 2; retry with line 2/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect gives candidate lines for a markerless identifier on the wrong line', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'sym.ts'),
          'export const greeting = 1;\nexport function inspectTarget() {}\n',
          'utf8'
        );
        const tools = buildDesktopAssistantTools(
          lspRuntime(workspaceRootPath, 'lsp-markerless-line')
        );
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        await expect(
          executeTool({
            context: { line: 1, match: 'export const x', path: '/src/sym.ts' },
          })
        ).rejects.toThrow(/must be one JavaScript\/TypeScript identifier/i);

        await expect(
          executeTool({
            context: { line: 1, match: 'inspectTarget', path: '/src/sym.ts' },
          })
        ).rejects.toThrow(/occurs on line 2.*retry with line 2/i);
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
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-stale-match'));
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        const inspection = executeTool({
          // Model quoted a line that isn't the real line 1 → must refuse with
          // the actual line text, never inspect a wrong column.
          context: { line: 1, match: 'const nonexistent = <<<thing;', path: '/src/x.ts' },
        });

        await expect(inspection).rejects.toBeInstanceOf(ToolInputError);
        await expect(inspection).rejects.toThrow(/not found on line 1/i);
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
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-ambiguous'));
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        await expect(
          executeTool({
            // "value" appears twice on line 1 → the column is ambiguous.
            context: { line: 1, match: '<<<value', path: '/src/dup.ts' },
          })
        ).rejects.toThrow(/more than once/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }, 30_000);

    it('lspInspect omits the preview for an oversized definition target but keeps path/line (review)', async () => {
      const workspaceRootPath = await createLspWorkspace();
      try {
        // Definition target > 2 MB (a stand-in for a large generated .d.ts):
        // the location must still resolve, but the accessory preview is skipped
        // rather than slurping the whole file into memory.
        const bigTarget = `export const bigSym = 1;\n// ${'a'.repeat(2_200_000)}\n`;
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'big.ts'),
          bigTarget,
          'utf8'
        );
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'src', 'use.ts'),
          "import { bigSym } from './big';\nexport const use = bigSym;\n",
          'utf8'
        );
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-big-target'));
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        const result = await executeTool({
          context: {
            line: 2,
            match: 'export const use = <<<bigSym;',
            path: '/src/use.ts',
          },
        });

        expect(result.available).toBe(true);
        expect(result.definition?.[0]?.path).toBe('/src/big.ts');
        expect(result.definition?.[0]?.line).toBe(1);
        expect(result.definition?.[0]?.preview).toBeUndefined();
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
        const tools = buildDesktopAssistantTools(lspRuntime(workspaceRootPath, 'lsp-bad-cursor'));
        const executeTool = requireToolExecute(tools, 'brainstrike.lspInspect');

        await expect(
          executeTool({
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
