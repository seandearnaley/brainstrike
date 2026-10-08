import type { McpBearerCredentialAuthority } from '@brainstrike/host-capabilities/mcp/bearer-credential';
import {
  McpHostRuntime,
  type McpHostRuntimeDependencies,
} from '@brainstrike/host-capabilities/mcp/node-host-runtime';
import type { McpOAuthStore } from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import { createDesktopMcpHostPlatform } from './desktop-host-platform';
import { RemoteMcpRuntime } from './remote-runtime';

export type { ExplicitClient } from '@brainstrike/host-capabilities/mcp/host-connection';

/** Compatibility composition root for the existing desktop singleton and test seams. */
export interface DesktopMcpHostRuntimeDependencies extends McpHostRuntimeDependencies {
  bearerCredentialAuthority?: McpBearerCredentialAuthority;
  oauthStore?: McpOAuthStore;
  openExternal?: (url: string) => Promise<void>;
}

/** The desktop composes the same authority consumed by a plain Node host. */
export class DesktopMcpHostRuntime extends McpHostRuntime {
  constructor(dependencies: DesktopMcpHostRuntimeDependencies = {}) {
    super(createDesktopMcpHostPlatform(dependencies), {
      clientName: 'brainstrike-desktop',
      ...dependencies,
    });
  }
}

export const createDesktopMcpHostRuntime = (
  dependencies?: DesktopMcpHostRuntimeDependencies
): DesktopMcpHostRuntime => new DesktopMcpHostRuntime(dependencies);

let singleton: RemoteMcpRuntime | undefined;
/**
 * Main's view of the desktop's one MCP runtime, which the Node agent host owns
 * (BST-1930 c1). Main constructs no local runtime; only the conformance client
 * composes `DesktopMcpHostRuntime` in its own plain-Node process.
 */
export const getDesktopMcpHostRuntime = (): RemoteMcpRuntime =>
  (singleton ??= new RemoteMcpRuntime());
