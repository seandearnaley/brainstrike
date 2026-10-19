/**
 * The agent partition's route to the network (BST-1238): the egress proxy,
 * the session routed through it, and the per-launch proxy credential
 * Chromium is answered with. Electron forwards every webContents `login` to
 * `app`, and requests without a webContents (service workers) arrive there
 * directly, so one `app` handler answers them all, and only for this proxy's
 * own address.
 */
import { app, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';
import { type AgentEgress, AgentEgressHost } from './agent-egress/agent-egress-host';
import type { EgressRefusal } from './agent-egress/egress-proxy';
import { type RefusedAgentResponse, routeAgentBrowserSession } from './browser-session';

export interface AgentBrowsingRoute {
  /** Start (or restart) the proxy and route the agent partition through it. */
  prepare(onRefused: (response: RefusedAgentResponse) => void): Promise<void>;
  /** Take the proxy's fresh refusal of `host`, to name a tunnel failure (once). */
  takeRefusal(host: string): EgressRefusal | undefined;
}

/** The proxy a route uses: by default the egress utility process. */
export type AgentEgressSource = Pick<AgentEgressHost, 'ensure' | 'takeRefusal'>;

function forkEgressHost(): AgentEgressHost {
  return new AgentEgressHost(() =>
    utilityProcess.fork(
      resolveBundledSiblingPath('Agent browsing egress', 'agent-egress-entry.js'),
      [],
      { serviceName: 'brainstrike-agent-egress' }
    )
  );
}

export function createAgentBrowsingRoute(
  egress: AgentEgressSource = forkEgressHost()
): AgentBrowsingRoute {
  let current: AgentEgress | null = null;
  let answering = false;
  return {
    async prepare(onRefused) {
      const proxy = await egress.ensure();
      current = proxy;
      if (!answering) {
        app.on('login', (event, _webContents, _details, authInfo, callback) => {
          const route = current;
          if (
            route !== null &&
            authInfo.isProxy &&
            authInfo.host === '127.0.0.1' &&
            authInfo.port === route.port
          ) {
            event.preventDefault();
            callback(route.username, route.password);
          }
        });
        answering = true;
      }
      await routeAgentBrowserSession(proxy.port, onRefused);
    },
    takeRefusal: (host) => egress.takeRefusal(host),
  };
}
