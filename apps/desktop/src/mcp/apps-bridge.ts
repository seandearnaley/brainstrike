import {
  MCP_APPS_IPC_CHANNELS,
  parseMcpAppExecuteRequest,
  parseMcpAppExecuteResult,
  parseMcpAppPrepareRequest,
  parseMcpAppPrepareResult,
} from '@brainstrike/assistant-contract';
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import type { McpDesktopAppHost } from './apps-authority';

export interface McpAppsBridgeRuntime {
  readonly appHost: Pick<McpDesktopAppHost, 'execute' | 'prepare' | 'release'>;
}

const MCP_APPS_SENDER_POLICY = { roles: ['visible-ui'] } as const;

export function attachMcpAppsBridge(
  runtime: McpAppsBridgeRuntime,
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): void {
  registry.registerAuthorizedInvoke(
    'mcp',
    MCP_APPS_IPC_CHANNELS.prepare,
    MCP_APPS_SENDER_POLICY,
    async (event, value: unknown) =>
      parseMcpAppPrepareResult(
        await runtime.appHost.prepare(event.sender, parseMcpAppPrepareRequest(value))
      )
  );
  registry.registerAuthorizedInvoke(
    'mcp',
    MCP_APPS_IPC_CHANNELS.execute,
    MCP_APPS_SENDER_POLICY,
    async (event, value: unknown) =>
      parseMcpAppExecuteResult(
        await runtime.appHost.execute(event.sender, parseMcpAppExecuteRequest(value))
      )
  );
  registry.registerAuthorizedInvoke(
    'mcp',
    MCP_APPS_IPC_CHANNELS.release,
    MCP_APPS_SENDER_POLICY,
    async (event, value: unknown): Promise<void> => {
      await runtime.appHost.release(event.sender, parseMcpAppExecuteRequest(value));
    }
  );
}
