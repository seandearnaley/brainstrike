import type { McpTaskStorage } from '@brainstrike/assistant-contract/mcp-task-store';
import type { McpBearerCredentialAuthority } from '@brainstrike/host-capabilities/mcp/bearer-credential';
import {
  McpHostRuntime,
  type McpHostRuntimeDependencies,
} from '@brainstrike/host-capabilities/mcp/node-host-runtime';
import type { McpOAuthStore } from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import { createDesktopMcpHostPlatform } from './conformance-host-platform';

export type { ExplicitClient } from '@brainstrike/host-capabilities/mcp/host-connection';

/** Compatibility composition root for the existing desktop singleton and test seams. */
export interface DesktopMcpHostRuntimeDependencies extends McpHostRuntimeDependencies {
  bearerCredentialAuthority?: McpBearerCredentialAuthority;
  oauthStore?: McpOAuthStore;
  openExternal?: (url: string) => Promise<void>;
  openTaskStorage?: () => Promise<McpTaskStorage>;
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
