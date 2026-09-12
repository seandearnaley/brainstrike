import '@testing-library/jest-dom/vitest';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DelegatedConversationRoot } from '../delegated-conversation-owner';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { DelegatedSidebarCell } from '../delegated-sidebar-cell';
import type { ThreadPanelVisibleRow } from '../thread-panel-visible-rows';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';
import { useDelegatedSidebar } from '../use-delegated-sidebar';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
let rows: ThreadPanelVisibleRow[];
let childThreadId: string;
let activeRoot: DelegatedConversationRoot | undefined;
const identity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'child-call',
  personaId: 'explore',
};
vi.mock('@brainstrike/db/react', async (original) => ({
  ...(await original<typeof import('@brainstrike/db/react')>()),
  usePGliteDatabase: () => database,
}));

function Sidebar() {
  const liveRoot = useDelegatedConversationRoot('owner', rows[0]?.id ?? '');
  useEffect(() => {
    activeRoot = liveRoot;
  }, [liveRoot]);
  const sidebar = useDelegatedSidebar(rows);
  const root = rows[0];
  if (!root) {
    throw new Error('Missing root fixture');
  }
  return (
    <>
      <button onClick={() => sidebar.toggle(root)} type="button">
        Toggle root
      </button>
      {sidebar.rows.map((row) =>
        row.kind === 'delegated' || row.kind === 'delegated-state' ? (
          <DelegatedSidebarCell key={row.id} onShowMore={sidebar.showMore} row={row} />
        ) : null
      )}
    </>
  );
}

beforeEach(async () => {
  database = await wasmLoader.createPGlite('memory://');
  await migrate(database);
  const history = createPgliteAssistantThreadRepository(database as DbHandle);
  const root = await history.createThread('owner');
  const child = await history.createThread('native-child');
  childThreadId = child.id;
  rows = [{ groupId: null, id: root.id, kind: 'thread', parentId: null, thread: root }];
  await history.createThreadRun({
    id: 'host',
    model: 'test',
    provider: 'openai',
    resourceId: 'owner',
    runtimeKind: 'hosted',
    status: 'completed',
    threadId: root.id,
    turnMessageId: 'root-user',
  });
  const graph = createDelegatedConversationRepository(database);
  const scope = { ownerResourceId: 'owner', rootThreadId: root.id };
  await graph.registerRoot(scope);
  await graph.createChild(scope, {
    color: 'emerald',
    configuration: {},
    displayName: 'Cedar',
    parentThreadId: root.id,
    resourceId: 'native-child',
    threadId: child.id,
  });
  await graph.createInvocation(scope, {
    ...identity,
    hostRunId: 'host',
    parentThreadId: root.id,
    threadId: child.id,
  });
  await graph.bindInvocationRun(scope, identity, identity.childRuntimeRunId);
  const sibling = await history.createThread('native-sibling');
  await graph.createChild(scope, {
    color: 'blue',
    configuration: {},
    displayName: 'Flint',
    parentThreadId: root.id,
    resourceId: 'native-sibling',
    threadId: sibling.id,
  });
  Object.defineProperty(window, 'assistant', {
    configurable: true,
    value: { url: 'http://assistant.test' },
  });
});
afterEach(async () => {
  cleanup();
  Reflect.deleteProperty(window, 'assistant');
  vi.unstubAllGlobals();
  activeRoot = undefined;
  await database.close();
});

it('restores pending child attention in a fresh sidebar without mounting a transcript', async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/assistant/suspended-runs');
    expect(url.searchParams.get('threadId')).toBe(rows[0]?.id);
    expect(url.searchParams.get('resourceId')).toBe('owner');
    return Response.json({
      approvals: [
        {
          args: { path: 'report.txt' },
          decisionState: 'interrupted',
          delegation: { path: [identity], toolCallId: 'leaf' },
          runId: identity.parentRuntimeRunId,
          stale: false,
          suspendedAt: '2026-09-10T00:00:00.000Z',
          toolCallId: identity.parentToolCallId,
          toolName: 'workspace.writeFile',
        },
      ],
      suspends: [],
    });
  });
  vi.stubGlobal('fetch', fetch);
  const first = render(
    <DelegatedConversationRootsProvider>
      <Sidebar />
    </DelegatedConversationRootsProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Cedar\s*Needs input$/u })).toBeVisible()
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /^Flint\s*Child$/u })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Cedar' })).not.toBeInTheDocument();
  first.unmount();
  render(
    <DelegatedConversationRootsProvider>
      <Sidebar />
    </DelegatedConversationRootsProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Cedar\s*Needs input$/u })).toBeVisible()
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  act(() => activeRoot?.onDelegatedConversation(delegatedUpdate(childThreadId)));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Cedar.*Working/u })).toBeVisible()
  );
  expect(screen.queryByText('Needs input')).not.toBeInTheDocument();
});

it('shows a discovery failure and revalidates on disclosure reopen instead of claiming no pending child', async () => {
  const fetch = vi.fn(async () => Response.json({}, { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  render(
    <DelegatedConversationRootsProvider>
      <Sidebar />
    </DelegatedConversationRootsProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Child attention could not be verified')
  );
  expect(screen.queryByRole('button', { name: /Cedar/u })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  fetch.mockImplementation(async () => Response.json({ approvals: [], suspends: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Cedar\s*Child$/u })).toBeVisible()
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects a rediscovered decision whose native invocation binding has changed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        approvals: [
          {
            args: {},
            decisionState: 'interrupted',
            delegation: {
              path: [{ ...identity, childRuntimeRunId: 'foreign-run' }],
              toolCallId: 'leaf',
            },
            runId: identity.parentRuntimeRunId,
            stale: false,
            suspendedAt: '2026-09-10T00:00:00.000Z',
            toolCallId: identity.parentToolCallId,
            toolName: 'workspace.writeFile',
          },
        ],
        suspends: [],
      })
    )
  );
  render(
    <DelegatedConversationRootsProvider>
      <Sidebar />
    </DelegatedConversationRootsProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invalid-response'));
  expect(screen.queryByText('Needs input')).not.toBeInTheDocument();
});
