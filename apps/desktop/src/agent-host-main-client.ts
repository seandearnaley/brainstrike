import type { HostClient } from '@brainstrike/agent-host/client';
import type { HostMethod, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
export interface AgentHostMainClient {
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResults[M]>;
}
/**
 * Main's own client of the host it launched: the desktop origin, on a port only
 * Main holds. Settings credential writes reach the profile's single credential
 * owner through it. A lost host is relaunched by the next request.
 */
export function createAgentHostMainClient(
  acquireProfile: () => Promise<HostClient>
): AgentHostMainClient {
  return {
    request: async (method, params) => await (await acquireProfile()).request(method, params),
  };
}
