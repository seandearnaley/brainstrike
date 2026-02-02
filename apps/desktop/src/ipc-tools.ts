/**
 * IPC Handlers for Tool Execution
 *
 * Provides the bridge between renderer process (Tool Playground) and
 * tool execution in the main process.
 */

import { createLogger } from '@brainstrike/utils';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { callTool } from './mcp';
import { executeNativeTool, isExecutableNativeTool } from './native-tool-executor';

const logger = createLogger('IpcTools');

/**
 * Result of executing a tool via IPC.
 */
interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Register IPC handlers for tool execution.
 */
export function registerToolsIpcHandlers(): void {
  logger.info('Registering tools IPC handlers');

  ipcMain.handle(
    'tools:execute',
    async (
      _event: IpcMainInvokeEvent,
      toolId: string,
      input: unknown
    ): Promise<ToolExecutionResult> => {
      const startTime = performance.now();
      logger.debug('Executing tool', { toolId });

      try {
        // Check if it's an executable native tool
        if (isExecutableNativeTool(toolId)) {
          return await executeNativeTool(toolId, input);
        }

        // Try MCP tool execution
        const result = await callTool(toolId, input as Record<string, unknown>);

        return {
          success: true,
          result,
          durationMs: Math.round(performance.now() - startTime),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
        logger.error('Tool execution failed', { toolId, error: errorMessage });

        return {
          success: false,
          error: errorMessage,
          durationMs: Math.round(performance.now() - startTime),
        };
      }
    }
  );
}
