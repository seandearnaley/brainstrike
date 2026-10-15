import { attachBrowserHost, type HostClient } from '@brainstrike/agent-host/browser';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { HostRecord } from '@brainstrike/host-lease';

/** Attach the visible frame to its main-owned profile host; no process/root is created here. */
export async function connectDesktopAgentHost(): Promise<HostClient> {
  const bridge = window.agentHost;
  if (!bridge) {
    throw new Error('Agent host client capability is unavailable');
  }
  const requestId = crypto.randomUUID();
  const received = Promise.withResolvers<{ record: HostRecord; port: MessagePort }>();
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
    } else if (data.type === 'agent-host/connected' && 'record' in payload) {
      const port = event.ports[0];
      if (!port) {
        received.reject(new Error('Agent client has no transferred port'));
        return;
      }
      // This is the main-owned lease DTO, authenticated again against the host's
      // initialize reply. It never becomes another renderer-owned lease record.
      received.resolve({ port, record: payload.record as HostRecord });
    }
  };
  received.promise.catch(() => undefined);
  window.addEventListener('message', receive);
  try {
    // Main's refusal (a profile closed for reset or quit) arrives typed.
    await callBoundary(() => bridge.connect(requestId));
    const { port, record } = await received.promise;
    return await attachBrowserHost(port, record, closed.promise);
  } catch (cause) {
    window.removeEventListener('message', receive);
    closed.resolve();
    throw cause;
  }
}
