import type { HostMethodHandler } from './auth-connection.js';
import type { HostClientOrigin, HostMcpContentService } from './ports.js';

/**
 * The desktop's MCP content browsing on one authenticated connection (BST-1930
 * c5d). Only the desktop's private client reaches it: resource and prompt
 * bodies are the desktop user's data, never a CLI's. Refusals answer in the
 * content taxonomy as results, so the transport carries no server text.
 */
export function bindHostMcpContentMethods(
  handle: HostMethodHandler,
  content: HostMcpContentService | undefined,
  origin: HostClientOrigin
): void {
  const service = (): HostMcpContentService => {
    if (origin !== 'desktop-ui') {
      throw new Error("MCP content is available only to the desktop's private client");
    }
    if (!content) {
      throw new Error('This host serves no MCP content');
    }
    return content;
  };
  handle('mcp/content/complete', (params) => service().complete(params));
  handle('mcp/content/prompt', (params) => service().prompt(params));
  handle('mcp/content/read', (params) => service().read(params));
}
