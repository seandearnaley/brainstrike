import './assistant-thread-tabs-workspace-test-support';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { AssistantThreadTabsWorkspace } from '../assistant-thread-tabs-workspace';
import { assistantWrapperProps } from './assistant-thread-tabs-workspace-test-support';

vi.mock('../legacy-thread-read-only-panel', () => ({
  LegacyThreadReadOnlyPanel: ({ threadId }: { readonly threadId: string }) => (
    <div data-testid="legacy-read-only-panel">{threadId}</div>
  ),
}));

/** A desktop agent host that owns none of the listed threads: every one is legacy. */
const hostOwningNothing: AssistantThreadHostCapability = {
  createThread: () => Promise.reject(new Error('not used')),
  deleteThread: () => Promise.resolve(false),
  listThreads: () => Promise.resolve([]),
  ownsThread: () => Promise.resolve(false),
  renameThread: () => Promise.reject(new Error('not used')),
  renderThread: () => undefined,
  updateThreadBinding: () => Promise.reject(new Error('not used')),
  workspaceRepository: (history) => history,
};

it('opens a legacy thread read-only and never mounts the interactive legacy chat when a host exists', async () => {
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  render(
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <AssistantThreadHostContext.Provider value={hostOwningNothing}>
        <AssistantThreadTabsWorkspace />
      </AssistantThreadHostContext.Provider>
    </ActionRegistryProvider>
  );

  expect(await screen.findByTestId('legacy-read-only-panel')).toHaveTextContent('thread-a');
  expect(screen.queryByTestId('assistant-thread-wrapper')).toBeNull();
  expect(assistantWrapperProps).toEqual([]);
});
