import {
  attachBrowserHost,
  type HostClient,
  type HostClientExpectation,
} from '@brainstrike/agent-host/browser';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';

/** The versions Main expects; the host's initialize reply is checked against them. */
function expectedHost(host: unknown): HostClientExpectation | undefined {
  if (
    host &&
    typeof host === 'object' &&
    'hostVersion' in host &&
    typeof host.hostVersion === 'string' &&
    'protocolVersion' in host &&
    typeof host.protocolVersion === 'number'
  ) {
    return { hostVersion: host.hostVersion, protocolVersion: host.protocolVersion };
  }
  return;
}
/** Attach the visible frame to its main-owned profile host; no process/root is created here. */
export async function connectDesktopAgentHost(): Promise<HostClient> {
  const bridge = window.agentHost;
  if (!bridge) {
    throw new Error('Agent host client capability is unavailable');
  }
  const requestId = crypto.randomUUID();
  const received = Promise.withResolvers<{ host: HostClientExpectation; port: MessagePort }>();
  const closed = Promise.withResolvers<void>();
  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') {
      return;
    }
    const data = event.data;
    if (
      !('type' in data && 'payload' in data && data.payload) ||
      typeof data.payload !== 'object'
    ) {
      return;
    }
    const payload = data.payload;
    if (!('requestId' in payload) || payload.requestId !== requestId) {
      return;
    }
    if (data.type === 'agent-host/disconnected') {
      closed.resolve();
      received.reject(new Error('Agent client disconnected before attach'));
      window.removeEventListener('message', receive);
    } else if (data.type === 'agent-host/connected' && 'host' in payload) {
      const port = event.ports[0];
      const host = expectedHost(payload.host);
      if (!(port && host)) {
        received.reject(new Error('Agent client has no transferred port or host versions'));
        return;
      }
      received.resolve({ host, port });
    }
  };
  received.promise.catch(() => undefined);
  window.addEventListener('message', receive);
  try {
    // Main's refusal (a profile closed for reset or quit) arrives typed.
    await callBoundary(() => bridge.connect(requestId));
    const { host, port } = await received.promise;
    const client = await attachBrowserHost(port, host, closed.promise);
    // The client also closes when this frame closes its port; Main's report then has no reader.
    const stopReceiving = (): void => window.removeEventListener('message', receive);
    client.closed.then(stopReceiving, stopReceiving);
    return client;
  } catch (cause) {
    window.removeEventListener('message', receive);
    closed.resolve();
    throw cause;
  }
}
