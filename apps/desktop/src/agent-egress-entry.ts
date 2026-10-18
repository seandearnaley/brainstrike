/**
 * Agent browsing's egress proxy, in its own utility process (BST-1238), so
 * the bytes of every agent-tab connection stay off Electron Main's event
 * loop. Main forks this entry, sends `start` with a per-launch credential,
 * and points the agent partition at the port this answers with.
 */
import { decodeEgressStart, type EgressEvent } from './browser/agent-egress/egress-protocol';
import { startEgressProxy } from './browser/agent-egress/egress-proxy';

const parentPort = process.parentPort;
if (!parentPort || process.type !== 'utility') {
  throw new Error('The agent egress proxy requires the Electron utility-process transport.');
}
const post = (event: EgressEvent): void => parentPort.postMessage(event);

parentPort.once('message', (event: Electron.MessageEvent) => {
  let credential: string;
  try {
    ({ credential } = decodeEgressStart(event.data));
  } catch (error) {
    post({ message: `Invalid agent egress start: ${String(error)}`, type: 'failed' });
    return;
  }
  startEgressProxy({
    credential,
    onRefusal: (refusal) => post({ refusal, type: 'refusal' }),
  }).then(
    (proxy) => post({ port: proxy.port, type: 'ready' }),
    (error: unknown) => post({ message: String(error), type: 'failed' })
  );
});
