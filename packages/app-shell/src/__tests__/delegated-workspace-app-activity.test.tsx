// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { delegatedWorkspaceTabId } from '../delegated-workspace-tab';
import { useDelegatedWorkspaceApps } from '../use-delegated-workspace-apps';

const mocks = vi.hoisted(() => ({
  active: new Set<string>(),
  db: {},
  get: vi.fn(),
  listeners: new Map<string, Set<() => void>>(),
  values: new Map<string, string>(),
}));
vi.mock('@brainstrike/db/react', () => ({
  useDbProviderError: () => null,
  usePGliteDatabase: () => mocks.db,
}));
vi.mock('@brainstrike/db', () => ({
  createDelegatedConversationRepository: () => ({ get: mocks.get }),
}));
vi.mock('../delegated-workspace-child-view', () => ({
  ChildView({ node }: { node: { threadId: string } }) {
    const [draft, setDraft] = useState('');
    const text = useSyncExternalStore(
      (listener) => {
        const listeners = mocks.listeners.get(node.threadId) ?? new Set<() => void>();
        listeners.add(listener);
        mocks.listeners.set(node.threadId, listeners);
        mocks.active.add(node.threadId);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            mocks.active.delete(node.threadId);
          }
        };
      },
      () => mocks.values.get(node.threadId) ?? '',
      () => ''
    );
    return (
      <>
        <label>
          {node.threadId}
          <input
            aria-label={`${node.threadId} draft`}
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
        </label>
        <output data-testid={`${node.threadId}-output`}>{text}</output>
      </>
    );
  },
  Failure({ error }: { error: Error }) {
    return <p role="alert">{error.message}</p>;
  },
}));

function Apps() {
  const apps = useDelegatedWorkspaceApps();
  return (
    <>
      {apps.map((app) => (
        <section key={app.id}>{app.render()}</section>
      ))}
    </>
  );
}

afterEach(() => {
  cleanup();
  useWorkspaceTabSelectionStore.getState().reset();
  mocks.active.clear();
  mocks.get.mockReset();
  mocks.listeners.clear();
  mocks.values.clear();
});

it('keeps only the selected child subscribed while preserving its draft across tab switches', async () => {
  mocks.get.mockImplementation(async (_scope, threadId: string) => ({
    color: 'blue',
    displayName: threadId,
    ownerResourceId: 'owner',
    parentThreadId: 'root',
    rootThreadId: 'root',
    threadId,
  }));
  const ids = ['a', 'b', 'c'].map((threadId) =>
    delegatedWorkspaceTabId({ ownerResourceId: 'owner', rootThreadId: 'root', threadId })
  );
  const [a, b, c] = ids;
  if (!(a && b && c)) {
    throw new Error('Expected three child tabs.');
  }
  useWorkspaceTabSelectionStore.getState().hydrate(ids, { appId: a, kind: 'app' });
  render(<Apps />);
  await waitFor(() => expect(mocks.active).toEqual(new Set(['a'])));
  act(() => {
    useWorkspaceTabSelectionStore.getState().selectApp(b);
  });
  await waitFor(() => expect(mocks.active).toEqual(new Set(['b'])));
  const draft = screen.getByRole('textbox', { name: 'b draft' });
  fireEvent.change(draft, { target: { value: 'keep me' } });
  // A third concurrently open child still must not subscribe while hidden.
  act(() => {
    useWorkspaceTabSelectionStore.getState().selectApp(c);
  });
  await waitFor(() => expect(mocks.active).toEqual(new Set(['c'])));
  act(() => {
    mocks.values.set('b', 'Completed while hidden');
    for (const listener of mocks.listeners.get('b') ?? []) {
      listener();
    }
  });
  expect(screen.getByTestId('b-output')).toHaveTextContent('');
  act(() => {
    useWorkspaceTabSelectionStore.getState().selectApp(b);
  });
  await waitFor(() => expect(mocks.active).toEqual(new Set(['b'])));
  expect(screen.getByRole('textbox', { name: 'b draft' })).toHaveValue('keep me');
  expect(screen.getByTestId('b-output')).toHaveTextContent('Completed while hidden');
});
