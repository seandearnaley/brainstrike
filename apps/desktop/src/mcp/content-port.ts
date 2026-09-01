import {
  createMcpContentApplicationPort,
  type McpContentApplicationPort,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { createLogger } from '@brainstrike/logging';
import type { DesktopMcpHostRuntime } from './host-runtime';

type McpContentRuntime = Pick<DesktopMcpHostRuntime, 'host'>;

const logger = createLogger('DesktopMcpContent');
const contentPorts = new WeakMap<McpContentRuntime, McpContentApplicationPort>();

/**
 * One content application port per Desktop MCP host runtime (BST-1585).
 *
 * The port is memoized against the runtime instance, so the reusable singleton
 * keeps one port across factory reset. Raw internal causes stay in this
 * main-process logger sink and never cross renderer IPC.
 */
export function getDesktopMcpContentPort(runtime: McpContentRuntime): McpContentApplicationPort {
  let port = contentPorts.get(runtime);
  if (!port) {
    port = createMcpContentApplicationPort(runtime.host, {
      onInternalError: (code, cause) => {
        logger.error('MCP content internal failure', { cause, code });
      },
    });
    contentPorts.set(runtime, port);
  }
  return port;
}
