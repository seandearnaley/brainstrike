/**
 * Forge observations walk every thread in the resource, host threads included.
 * The wrapper must hand `useForgeRunEvents` a host-routed repository, so a host
 * thread's `forgePrUrl` commits through its host binding instead of a history
 * UPDATE that matches no row (PR #3543 Group A).
 */
import './assistant-ui-panel-wrapper-test-support';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { loadTestLocalLlmBackend } from './assistant-ui-panel-wrapper-test-support';

const { forge } = vi.hoisted(() => ({
  forge: { repository: undefined as AssistantThreadRepository | null | undefined },
}));
vi.mock('../hooks/use-forge-run-events', () => ({
  useForgeBranchLookupActivation: () => false,
  useForgeRunEvents: (args: { readonly assistantThreadRepository: AssistantThreadRepository }) => {
    forge.repository = args.assistantThreadRepository;
  },
}));

describe('AssistantUiPanelWrapper — forge writer routing', () => {
  test('a host thread forge PR URL reaches the host binding, never history', async () => {
    const updateThreadBinding = vi.fn<AssistantThreadHostCapability['updateThreadBinding']>(
      async () => undefined
    );
    const host: AssistantThreadHostCapability = {
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(async () => []),
      ownsThread: vi.fn(async (threadId: string) => threadId === 'host-thread'),
      renameThread: vi.fn(),
      renderThread: vi.fn(),
      updateThreadBinding,
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    };
    render(
      <AssistantThreadHostContext.Provider value={host}>
        <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
          <AssistantUiPanelWrapper
            loadLocalLlmBackend={loadTestLocalLlmBackend}
            memoryResourceId="/tmp/test-workspace"
            memoryThreadId="legacy-thread"
            providerKeySources={[{ provider: 'openai', source: 'stored' }]}
          />
        </AssistantProviderSourceProvider>
      </AssistantThreadHostContext.Provider>
    );
    await screen.findByTestId('assistant-ui-panel');

    const repository = forge.repository;
    if (!repository) {
      throw new Error('The wrapper gave the forge writer no repository');
    }
    const patch = { forgePrUrl: 'https://github.com/acme/widgets/pull/2574' };
    await repository.updateThreadMetadata('host-thread', patch);
    expect(updateThreadBinding).toHaveBeenCalledExactlyOnceWith('host-thread', patch);
  });
});
