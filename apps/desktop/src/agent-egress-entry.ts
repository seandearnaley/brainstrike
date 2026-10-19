/**
 * Agent browsing's egress proxy, in its own utility process (BST-1238), so
 * the bytes of every agent-tab connection stay off Electron Main's event
 * loop. Main forks this entry, sends `start` with a per-launch credential,
 * and points the agent partition at the port this answers with. BST-1178:
 * Main then sends the loopback servers agent tabs may reach, each revision
 * answered once the proxy admits it.
 */
import {
  decodeEgressCommand,
  type EgressCommand,
  type EgressEvent,
} from './browser/agent-egress/egress-protocol';
import { type EgressProxy, startEgressProxy } from './browser/agent-egress/egress-proxy';

const parentPort = process.parentPort;
if (!parentPort || process.type !== 'utility') {
  throw new Error('The agent egress proxy requires the Electron utility-process transport.');
}
const post = (event: EgressEvent): void => parentPort.postMessage(event);

let proxy: Promise<EgressProxy> | undefined;

function start(credential: string): void {
  if (proxy !== undefined) {
    post({ message: 'The agent egress proxy was started twice', type: 'failed' });
    return;
  }
  proxy = startEgressProxy({
    credential,
    onRefusal: (refusal) => post({ refusal, type: 'refusal' }),
  });
  proxy.then(
    (running) => post({ port: running.port, type: 'ready' }),
    (error: unknown) => post({ message: String(error), type: 'failed' })
  );
}

/** Admit once the proxy runs, so a revision is never answered before it applies. */
function admitLoopback(authorities: readonly string[], revision: number): void {
  if (proxy === undefined) {
    post({ message: 'The proxy is not started', revision, type: 'loopback-refused' });
    return;
  }
  proxy.then(
    (running) => {
      try {
        running.admitLoopback(authorities);
        post({ revision, type: 'loopback-admitted' });
      } catch (error) {
        post({ message: String(error), revision, type: 'loopback-refused' });
      }
    },
    (error: unknown) => post({ message: String(error), revision, type: 'loopback-refused' })
  );
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  let command: EgressCommand;
  try {
    command = decodeEgressCommand(event.data);
  } catch (error) {
    post({ message: `Invalid agent egress command: ${String(error)}`, type: 'failed' });
    return;
  }
  if (command.type === 'start') {
    start(command.credential);
  } else {
    admitLoopback(command.authorities, command.revision);
  }
});
