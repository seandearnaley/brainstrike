import { attachBrowserHost } from '@brainstrike/agent-host/browser';
import type { HostRecord } from '@brainstrike/host-lease';
import { createRoot } from 'react-dom/client';
import { AgentHostPanel } from '../../renderer/components/agent-host-panel';

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (
    event.source !== window ||
    !data ||
    typeof data !== 'object' ||
    !('type' in data) ||
    data.type !== 'agent-host/port' ||
    !('record' in data)
  ) {
    return;
  }
  const port = event.ports[0];
  const element = document.getElementById('root');
  const threadId = new URLSearchParams(window.location.search).get('threadId');
  if (!(port && element && threadId)) {
    throw new Error('Owned host view capability was incomplete');
  }
  const closed = Promise.withResolvers<void>();
  attachBrowserHost(port, data.record as HostRecord, closed.promise)
    .then((client) => {
      const view = createRoot(element);
      view.render(<AgentHostPanel client={client} modelId="scripted" threadId={threadId} />);
      window.addEventListener(
        'beforeunload',
        () => {
          view.unmount();
          client.close();
          closed.resolve();
        },
        { once: true }
      );
    })
    .catch((cause: unknown) => {
      element.textContent = String(cause);
    });
});
