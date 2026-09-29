import {
  parseMcpAppExecuteRequest,
  parseMcpAppExecuteResult,
  parseMcpAppPrepareRequest,
  parseMcpAppPrepareResult,
} from '@brainstrike/assistant-contract';
import { mcpAppsContract } from '../ipc-domains/mcp.contract';
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import type { McpDesktopAppHost } from './apps-authority';

export interface McpAppsBridgeRuntime {
  readonly appHost: Pick<McpDesktopAppHost, 'execute' | 'prepare' | 'release'>;
}

export function attachMcpAppsBridge(
  runtime: McpAppsBridgeRuntime,
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): void {
  registry.registerAuthorizedInvoke(
    'mcp',
    mcpAppsContract.prepare.channel,
    { roles: mcpAppsContract.prepare.roles },
    async (event, ...raw: unknown[]) => {
      const [value] = mcpAppsContract.prepare.parseArgs(raw);
      return parseMcpAppPrepareResult(
        await runtime.appHost.prepare(event.sender, parseMcpAppPrepareRequest(value))
      );
    }
  );
  registry.registerAuthorizedInvoke(
    'mcp',
    mcpAppsContract.execute.channel,
    { roles: mcpAppsContract.execute.roles },
    async (event, ...raw: unknown[]) => {
      const [value] = mcpAppsContract.execute.parseArgs(raw);
      return parseMcpAppExecuteResult(
        await runtime.appHost.execute(event.sender, parseMcpAppExecuteRequest(value))
      );
    }
  );
  registry.registerAuthorizedInvoke(
    'mcp',
    mcpAppsContract.release.channel,
    { roles: mcpAppsContract.release.roles },
    async (event, ...raw: unknown[]): Promise<void> => {
      const [value] = mcpAppsContract.release.parseArgs(raw);
      await runtime.appHost.release(event.sender, parseMcpAppExecuteRequest(value));
    }
  );
}
