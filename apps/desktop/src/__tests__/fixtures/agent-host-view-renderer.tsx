import { attachBrowserHost } from '@brainstrike/agent-host/browser';
import { CommittedAssistantConversation } from '@brainstrike/assistant-ui';
import type { HostRecord } from '@brainstrike/host-lease';
import { TooltipProvider } from '@brainstrike/ui';
import { createRoot } from 'react-dom/client';
import { createCommittedHostConversation } from '../../renderer/committed-host-conversation';

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
  const disconnected = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (
      event.source === window &&
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'agent-host/disconnected'
    ) {
      closed.resolve();
    }
  };
  window.addEventListener('message', disconnected);
  attachBrowserHost(port, data.record as HostRecord, closed.promise)
    .then((client) => {
      const view = createRoot(element);
      const conversation = createCommittedHostConversation({
        client,
        modelId: 'scripted',
        threadId,
      });
      view.render(
        <TooltipProvider>
          <CommittedAssistantConversation
            commands={conversation.commands}
            label="Assistant"
            store={conversation.store}
          />
        </TooltipProvider>
      );
      window.addEventListener(
        'beforeunload',
        () => {
          view.unmount();
          conversation.close();
          void client.close();
          window.removeEventListener('message', disconnected);
          closed.resolve();
        },
        { once: true }
      );
    })
    .catch((cause: unknown) => {
      element.textContent = String(cause);
    });
});
