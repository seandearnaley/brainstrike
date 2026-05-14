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
  isNativeTool: vi.fn(),
}));

// Mock native tool executor
vi.mock('../../native-tool-executor', () => ({
  executeNativeTool: vi.fn(),
  isExecutableNativeTool: vi.fn(),
}));

// Mock MCP callTool
vi.mock('../../mcp', () => ({
  callTool: vi.fn(),
}));

import { isNativeTool } from '@brainstrike/agent/client';
import { ipcMain } from 'electron';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { callTool } from '../../mcp';
import { executeNativeTool, isExecutableNativeTool } from '../../native-tool-executor';

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
    vi.resetModules();
  });

  const mockEvent = {} as IpcMainInvokeEvent;

  describe('tools:execute', () => {
    it('executes native tools via executeNativeTool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(true);
      vi.mocked(executeNativeTool).mockResolvedValue({
        success: true,
        result: { data: 'test' },
        durationMs: 10,
      });

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('brainstrike.readWorkspaceFile');
      expect(executeNativeTool).toHaveBeenCalledWith('brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });
      expect(result).toEqual({
        success: true,
        result: { data: 'test' },
        durationMs: 10,
      });
    });

    it('rejects invalid tool IDs', async () => {
      const result = await toolsExecuteHandler(mockEvent, '   ', {});

      expect(result).toMatchObject({
        success: false,
        error: 'Invalid tool ID.',
      });
    });

    it('rejects non-object inputs for native tools', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(true);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', [
        'not',
        'object',
      ]);

      expect(executeNativeTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: 'Tool input must be a JSON object.',
      });
    });

    it('rejects overly deep native tool inputs', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(true);

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

      expect(executeNativeTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('JSON-serializable'),
      });
    });

    it('executes MCP tools via callTool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockResolvedValue({ mcpResult: 'success' });

      const result = await toolsExecuteHandler(mockEvent, 'mcp__server__tool', { param: 'value' });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('mcp__server__tool');
      expect(callTool).toHaveBeenCalledWith('mcp__server__tool', { param: 'value' });
      expect(result).toMatchObject({
        success: true,
        result: { mcpResult: 'success' },
      });
    });

    it('executes assistant runtime native tools when runtime context is provided', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
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
          workspaceRootPath: '/tmp/test-workspace',
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingMode: 'root-folder-cache',
          workspaceIndexingPaused: false,
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingMode: 'root-folder-cache',
          workspaceIndexingPaused: false,
        },
        { embeddingHostManager: undefined }
      );
      expect(callTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        result: { content: 'hello' },
      });
    });

    it('passes only structurally valid workspace context metadata to assistant runtime tools', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
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
          workspaceRootPath: '/tmp/test-workspace',
          workspaceContext: {
            tokenBudget: 8192,
            selectedSourceApproxTokens: 320,
            selectedOutputApproxTokens: null,
            useTapestryRanges: true,
            includeProjectTree: false,
            files: [
              {
                path: '/src/main.ts',
                approxTokens: 200,
                outputApproxTokens: 120,
                ranges: [
                  {
                    startLine: 4,
                    endLine: 12,
                    approxTokens: 60,
                    isActive: true,
                  },
                ],
              },
            ],
          },
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
          workspaceContext: {
            tokenBudget: 8192,
            selectedSourceApproxTokens: 320,
            selectedOutputApproxTokens: null,
            useTapestryRanges: true,
            includeProjectTree: false,
            files: [
              {
                path: '/src/main.ts',
                approxTokens: 200,
                outputApproxTokens: 120,
                ranges: [
                  {
                    startLine: 4,
                    endLine: 12,
                    approxTokens: 60,
                    isActive: true,
                  },
                ],
              },
            ],
          },
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        success: true,
        result: { files: [] },
      });
    });

    it('omits invalid workspace indexing mode values before assistant runtime tool execution', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
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
          workspaceRootPath: '/tmp/test-workspace',
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingMode: 'unexpected-mode',
          workspaceIndexingPaused: false,
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
          workspaceIndexEmbeddingSetId: 'set-1',
          workspaceIndexingEnabled: true,
          workspaceIndexingPaused: false,
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        success: true,
        result: { spaces: [] },
      });
    });

    it('omits invalid workspace context metadata before assistant runtime tool execution', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
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
          workspaceRootPath: '/tmp/test-workspace',
          workspaceContext: {
            files: [
              {
                path: '/src/main.ts',
                ranges: [{ startLine: 12, endLine: 4 }],
              },
            ],
          },
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        success: true,
        result: { files: [] },
      });
    });

    it('passes enabled native tools and agent loop metadata to assistant runtime tools', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
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
          workspaceRootPath: '/tmp/test-workspace',
          enabledNativeToolIds: ['brainstrike.readWorkspaceContext', null, ''],
          agentLoop: {
            maxSteps: 12,
            inputTokenLimit: 8192,
            invalid: 99,
          },
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
          enabledNativeToolIds: ['brainstrike.readWorkspaceContext'],
          agentLoop: {
            maxSteps: 12,
            inputTokenLimit: 8192,
          },
        },
        { embeddingHostManager: undefined }
      );
      expect(result).toMatchObject({
        success: true,
        result: { files: [] },
      });
    });

    it('preserves an empty enabled native tool list for assistant runtime tools', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
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
          workspaceRootPath: '/tmp/test-workspace',
          enabledNativeToolIds: [],
        }
      );

      expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
        {
          workspaceRootPath: '/tmp/test-workspace',
          enabledNativeToolIds: [],
        },
        { embeddingHostManager: undefined }
      );
    });

    it('returns friendly error for native tools requiring database access', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(true);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('brainstrike.readWorkspaceFile');
      expect(isNativeTool).toHaveBeenCalledWith('brainstrike.readWorkspaceFile');
      expect(callTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('requires database access'),
      });
    });

    it('handles MCP tool execution errors', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockRejectedValue(new Error('MCP server disconnected'));

      const result = await toolsExecuteHandler(mockEvent, 'mcp__server__tool', {});

      expect(result).toMatchObject({
        success: false,
        error: 'MCP server disconnected',
      });
    });

    it('includes durationMs in all responses', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockResolvedValue({ data: 'test' });

      const result = (await toolsExecuteHandler(mockEvent, 'mcp__tool', {})) as {
        durationMs: number;
      };

      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles native tool execution errors gracefully', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(true);
      vi.mocked(executeNativeTool).mockRejectedValue(new Error('Native tool crashed'));

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });

      expect(result).toMatchObject({
        success: false,
        error: 'Native tool crashed',
      });
    });

    it('handles non-Error thrown values', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockRejectedValue('string error');

      const result = await toolsExecuteHandler(mockEvent, 'mcp__tool', {});

      expect(result).toMatchObject({
        success: false,
        error: 'Tool execution failed',
      });
    });

    it('rejects non-object MCP inputs before calling tool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);

      const result = await toolsExecuteHandler(mockEvent, 'mcp__tool', ['not', 'object']);

      expect(callTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: 'Tool input must be a JSON object.',
      });
    });

    it('rejects non-serializable MCP inputs', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);

      const result = await toolsExecuteHandler(mockEvent, 'mcp__tool', {
        value: () => {},
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('JSON-serializable'),
      });
    });

    it('rejects oversized MCP inputs before calling tool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);

      const result = await toolsExecuteHandler(mockEvent, 'mcp__tool', {
        payload: 'x'.repeat(1_000_001),
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('exceeds'),
      });
    });

    it('passes input as-is to MCP callTool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockResolvedValue({});

      const complexInput = {
        nested: { value: 123 },
        array: [1, 2, 3],
        string: 'test',
      };

      await toolsExecuteHandler(mockEvent, 'mcp__server__tool', complexInput);

      expect(callTool).toHaveBeenCalledWith('mcp__server__tool', complexInput);
    });
  });

  describe('handler registration', () => {
    it('should register tools:execute handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('tools:execute', expect.any(Function));
    });
  });
});
