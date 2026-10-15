import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_RESULT_SCHEMAS,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import {
  type AssistantThreadHostCapability,
  useAssistantThreadHost,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, test, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn<() => Promise<HostClient>>());
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: connect }));

import { DesktopHostThreadProvider } from '../../renderer/desktop-host-thread-provider';

/** A connected host whose catalog lists no thread. */
function emptyCatalogHost(): HostClient {
  const answers: Partial<Record<HostMethod, unknown>> = {
    'ledger/read': { threads: [] },
    'thread/list': { threads: [] },
  };
  return {
    get catalog(): HostClient['catalog'] {
      throw new Error('This thread fixture does not borrow the host catalog');
    },
    close: vi.fn(async () => undefined),
    // A live client: its transport stays open until the test or the frame closes it.
    closed: new Promise<void>(() => undefined),
    onChildrenChanged: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
    onMcpPresentation: vi.fn(() => () => undefined),
    onMcpSettings: vi.fn(() => () => undefined),
    onTelemetry: vi.fn(() => () => undefined),
    record: {
      endpoint: '/tmp/recorded-host-fixture',
      hostVersion: '0.1.0',
      pid: process.pid,
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      start: 'synthetic client fixture',
      token: 'a'.repeat(64),
    },
    request: async <Method extends HostMethod>(
      method: Method,
      _params: HostParams<Method>
    ): Promise<HostResults[Method]> => {
      if (!(method in answers)) {
        throw new Error(`Unexpected host request ${method}`);
      }
      return HOST_RESULT_SCHEMAS[method].parse(answers[method]) as HostResults[Method];
    },
  };
}

test('a thread the loaded host catalog does not own renders an explicit not-hosted failure', async () => {
  connect.mockResolvedValue(emptyCatalogHost());
  let host: AssistantThreadHostCapability | undefined;
  function Capture(): null {
    host = useAssistantThreadHost();
    return null;
  }
  render(
    <DesktopHostThreadProvider>
      <Capture />
    </DesktopHostThreadProvider>
  );
  if (!host) {
    throw new Error('The desktop provider supplied no thread host');
  }
  await host.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  // Desktop never falls back to another conversation owner for a thread it does not host.
  const view = host.renderThread('thread-the-host-does-not-own', true);
  expect(view).toBeDefined();
  render(view as ReactElement);
  expect(screen.getByRole('alert', { name: 'Agent host error' })).toHaveTextContent(
    'This thread is not owned by the agent host.'
  );
});
