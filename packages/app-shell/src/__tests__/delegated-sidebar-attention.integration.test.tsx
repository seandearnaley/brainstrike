import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import '@testing-library/jest-dom/vitest';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishDelegatedColorRefresh } from '../delegated-color-refresh';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { DelegatedSidebarCell } from '../delegated-sidebar-cell';
import type { ThreadPanelVisibleRow } from '../thread-panel-visible-rows';
import { useDelegatedSidebar } from '../use-delegated-sidebar';

let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
let rows: ThreadPanelVisibleRow[];
let childThreadId: string;
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
    id: 'host' as HostRunId,
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
});
afterEach(async () => {
  cleanup();
  await database.close();
});

it('repaints expanded saved child rows after an explicit color refresh', async () => {
  render(
    <DelegatedConversationRootsProvider>
      <Sidebar />
    </DelegatedConversationRootsProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Toggle root' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Cedar\s*Child$/u })).toHaveAttribute(
      'data-agent-color',
      'emerald'
    )
  );
  await database.query(
    'UPDATE brainstrike_delegated_conversations SET color = $1 WHERE thread_id = $2',
    ['violet', childThreadId]
  );
  act(publishDelegatedColorRefresh);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Cedar\s*Child$/u })).toHaveAttribute(
      'data-agent-color',
      'violet'
    )
  );
});
