import type { McpBearerCredentialAuthority } from './bearer-credential';
import { createDesktopMcpHostPlatform } from './desktop-host-platform';
import { McpHostRuntime, type McpHostRuntimeDependencies } from './node-host-runtime';
import type { McpOAuthStore } from './oauth-client-provider';

export type { ExplicitClient } from './host-connection';

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

let singleton: DesktopMcpHostRuntime | undefined;
export const getDesktopMcpHostRuntime = (): DesktopMcpHostRuntime =>
  (singleton ??= createDesktopMcpHostRuntime());
