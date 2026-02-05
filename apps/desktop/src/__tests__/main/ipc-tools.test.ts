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
import { callTool } from '../../mcp';
import { executeNativeTool, isExecutableNativeTool } from '../../native-tool-executor';

describe('ipc-tools', () => {
  let toolsExecuteHandler: (
    event: IpcMainInvokeEvent,
    toolId: string,
    input: unknown
  ) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

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

      const result = await toolsExecuteHandler(mockEvent, 'web.searchDocs', { query: 'test' });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('web.searchDocs');
      expect(executeNativeTool).toHaveBeenCalledWith('web.searchDocs', { query: 'test' });
      expect(result).toEqual({
        success: true,
        result: { data: 'test' },
        durationMs: 10,
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

    it('returns friendly error for native tools requiring database access', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(isNativeTool).mockReturnValue(true);

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.retrieveContext', {
        query: 'test',
      });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('brainstrike.retrieveContext');
      expect(isNativeTool).toHaveBeenCalledWith('brainstrike.retrieveContext');
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

      const result = await toolsExecuteHandler(mockEvent, 'web.searchDocs', { query: 'test' });

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
