import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock @brainstrike/agent/client
vi.mock('@brainstrike/agent/client', () => ({
  DESKTOP_NATIVE_TOOL_IDS: ['brainstrike.readWorkspaceContext'],
  isNativeTool: vi.fn(),
  NATIVE_TOOL_DEFAULTS: {
    'brainstrike.readWorkspaceContext': {
      category: 'retrieval',
      estimatedTokens: 180,
      loadingTier: 'critical',
      requiresApproval: false,
    },
    skill_read: {
      category: 'retrieval',
      estimatedTokens: 120,
      loadingTier: 'critical',
      requiresApproval: false,
    },
  },
}));

import { isNativeTool } from '@brainstrike/agent/client';
import { ipcMain } from 'electron';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

vi.mock('../../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(),
}));

describe('ipc-tools', () => {
  let toolsExecuteHandler: (
    event: IpcMainInvokeEvent,
    toolId: unknown,
    input: unknown,
    runtimeData?: unknown
  ) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.mocked(buildDesktopAssistantTools).mockReset();
    vi.mocked(buildDesktopAssistantTools).mockReturnValue({} as never);

    // Import and register handlers
    const { registerToolsIpcHandlers } = await import('../../ipc-tools');
    registerToolsIpcHandlers();

    // Extract the registered handler
    const handleCalls = vi.mocked(ipcMain.handle).mock.calls;
    const toolsCall = handleCalls.find(([channel]) => channel === 'tools:execute');
    if (!toolsCall) {
      throw new Error('tools:execute handler not registered');
    }
    toolsExecuteHandler = toolsCall[1] as typeof toolsExecuteHandler;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const mockEvent = {} as IpcMainInvokeEvent;

  describe('tools:execute', () => {
    it('rejects invalid tool IDs', async () => {
      const result = await toolsExecuteHandler(mockEvent, '   ', {});

      expect(result).toMatchObject({
        error: 'Invalid tool ID.',
        success: false,
      });
    });

    it('rejects non-object inputs for native tools', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      const execute = vi.fn();
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceFile': { execute },
      } as never);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', [
        'not',
        'object',
      ]);

      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error: 'Tool input must be a JSON object.',
        success: false,
      });
    });

    it('rejects overly deep native tool inputs', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      const execute = vi.fn();
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceDirectory': { execute },
      } as never);

      const deepInput: { child?: unknown } = {};
      let cursor: { child?: unknown } = deepInput;
      for (let i = 0; i < 20; i += 1) {
        const next: { child?: unknown } = {};
        cursor.child = next;
        cursor = next;
      }

      const result = await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceDirectory',
        deepInput
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error: expect.stringContaining('JSON-serializable'),
        success: false,
      });
    });

    it('rejects non-native tools instead of exposing an MCP execution bypass', async () => {
      vi.mocked(isNativeTool).mockReturnValue(false);

      const result = await toolsExecuteHandler(mockEvent, 'mcp__server__tool', { param: 'value' });

      expect(result).toMatchObject({
        error: expect.stringContaining('not available in the native Tool Playground harness'),
        success: false,
      });
    });

    it('executes assistant runtime native tools when runtime context is provided', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceFile': {
          execute: vi.fn().mockResolvedValue({ content: 'hello' }),
        },
      } as never);

      const result = await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceFile',
        {
          path: '/README.md',
        },
        {
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingMode: 'root-folder-cache',
          workspaceIndexingPaused: false,
          workspaceRootPath: '/tmp/test-workspace',
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingMode: 'root-folder-cache',
          workspaceIndexingPaused: false,
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        result: { content: 'hello' },
        success: true,
      });
    });

    it('passes only structurally valid workspace context metadata to assistant runtime tools (flag-less payload)', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceContext': {
          execute: vi.fn().mockResolvedValue({ files: [] }),
        },
      } as never);

      const result = await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceContext',
        {
          tokenBudget: 500,
        },
        {
          workspaceContext: {
            files: [
              {
                approxTokens: 200,
                outputApproxTokens: 120,
                path: '/src/main.ts',
                ranges: [
                  {
                    approxTokens: 60,
                    endLine: 12,
                    isActive: true,
                    startLine: 4,
                  },
                ],
              },
            ],
            includeProjectTree: false,
            selectedOutputApproxTokens: null,
            selectedSourceApproxTokens: 320,
            tokenBudget: 8192,
          },
          workspaceRootPath: '/tmp/test-workspace',
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceContext: {
            files: [
              {
                approxTokens: 200,
                outputApproxTokens: 120,
                path: '/src/main.ts',
                ranges: [
                  {
                    approxTokens: 60,
                    endLine: 12,
                    isActive: true,
                    startLine: 4,
                  },
                ],
              },
            ],
            includeProjectTree: false,
            selectedOutputApproxTokens: null,
            selectedSourceApproxTokens: 320,
            tokenBudget: 8192,
          },
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        result: { files: [] },
        success: true,
      });
    });

    it('passes through file root identity (Phase 6) and drops malformed values', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceContext': {
          execute: vi.fn().mockResolvedValue({ files: [] }),
        },
      } as never);

      await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceContext',
        {},
        {
          workspaceContext: {
            files: [
              {
                path: 'src/notes.md',
                rootDisplayName: 'docs',
                rootId: 'aaaaaaaa-0000-4000-8000-000000000001',
              },
              {
                path: 'src/other.md',
                rootDisplayName: '',
                // Malformed identities must be dropped, not forwarded.
                rootId: 42,
              },
            ],
          },
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceContext: {
            files: [
              {
                path: 'src/notes.md',
                rootDisplayName: 'docs',
                rootId: 'aaaaaaaa-0000-4000-8000-000000000001',
              },
              {
                path: 'src/other.md',
              },
            ],
          },
        },
        { embeddingHostManager: undefined }
      );
    });

    it('omits invalid workspace indexing mode values before assistant runtime tool execution', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.listEmbeddingSpaces': {
          execute: vi.fn().mockResolvedValue({ spaces: [] }),
        },
      } as never);

      const result = await toolsExecuteHandler(
        mockEvent,
        'brainstrike.listEmbeddingSpaces',
        {},
        {
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingMode: 'unexpected-mode',
          workspaceIndexingPaused: false,
          workspaceRootPath: '/tmp/test-workspace',
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingPaused: false,
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        result: { spaces: [] },
        success: true,
      });
    });

    it('omits invalid workspace context metadata before assistant runtime tool execution', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceContext': {
          execute: vi.fn().mockResolvedValue({ files: [] }),
        },
      } as never);

      const result = await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceContext',
        {
          tokenBudget: 500,
        },
        {
          workspaceContext: {
            files: [
              {
                path: '/src/main.ts',
                ranges: [{ endLine: 4, startLine: 12 }],
              },
            ],
          },
          workspaceRootPath: '/tmp/test-workspace',
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        result: { files: [] },
        success: true,
      });
    });

    it('passes enabled native tools and agent loop metadata to assistant runtime tools', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceContext': {
          execute: vi.fn().mockResolvedValue({ files: [] }),
        },
      } as never);

      const result = await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceContext',
        { tokenBudget: 500 },
        {
          agentLoop: {
            inputTokenLimit: 8192,
            invalid: 99,
            maxSteps: 12,
          },
          enabledNativeToolIds: [
            ' brainstrike.readWorkspaceContext ',
            'skill_read',
            null,
            '',
            'brainstrike.unknownNativeTool',
          ],
          workspaceRootPath: '/tmp/test-workspace',
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          agentLoop: {
            inputTokenLimit: 8192,
            maxSteps: 12,
          },
          enabledNativeToolIds: ['brainstrike.readWorkspaceContext'],
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        result: { files: [] },
        success: true,
      });
    });

    it('preserves an empty enabled native tool list for assistant runtime tools', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceContext': {
          execute: vi.fn().mockResolvedValue({ files: [] }),
        },
      } as never);

      await toolsExecuteHandler(
        mockEvent,
        'brainstrike.readWorkspaceContext',
        { tokenBudget: 500 },
        {
          enabledNativeToolIds: [],
          workspaceRootPath: '/tmp/test-workspace',
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          enabledNativeToolIds: [],
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
    });

    it('returns friendly error for native tools requiring database access', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });

      expect(isNativeTool).toHaveBeenCalledWith('brainstrike.readWorkspaceFile');
      expect(result).toMatchObject({
        error: expect.stringContaining('requires database access'),
        success: false,
      });
    });

    it('includes durationMs in all responses', async () => {
      vi.mocked(isNativeTool).mockReturnValue(false);

      const result = (await toolsExecuteHandler(mockEvent, 'mcp__tool', {})) as {
        durationMs: number;
      };

      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles native tool execution errors gracefully', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceFile': {
          execute: vi.fn().mockRejectedValue(new Error('Native tool crashed')),
        },
      } as never);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });

      expect(result).toMatchObject({
        error: 'Native tool crashed',
        success: false,
      });
    });

    it('handles non-Error thrown values', async () => {
      vi.mocked(isNativeTool).mockReturnValue(true);
      vi.mocked(buildDesktopAssistantTools).mockReturnValue({
        'brainstrike.readWorkspaceFile': {
          execute: vi.fn().mockRejectedValue('string error'),
        },
      } as never);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', {});

      expect(result).toMatchObject({
        error: 'Tool execution failed',
        success: false,
      });
    });
  });

  describe('handler registration', () => {
    it('refuses production registration before any execution sink becomes reachable', async () => {
      vi.mocked(ipcMain.handle).mockClear();
      vi.stubEnv('NODE_ENV', 'production');
      const { registerToolsIpcHandlers } = await import('../../ipc-tools');

      expect(() => registerToolsIpcHandlers()).toThrow(
        'Renderer tool execution IPC is disabled outside tests (NODE_ENV=test); tool execution belongs to the assistant permission engine.'
      );
      expect(ipcMain.handle).not.toHaveBeenCalled();
    });

    it('registers channels through the typed desktop IPC registry', () => {
      const source = readFileSync(path.resolve(import.meta.dirname, '../../ipc-tools.ts'), 'utf8');

      expect(source).toContain('createDesktopIpcRegistry');
      expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
      expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
    });

    it('should register tools:execute handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('tools:execute', expect.any(Function));
    });
  });
});
