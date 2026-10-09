// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  type AssistantThreadHostChild,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useAssistantProviderSource } from '../hooks/assistant-provider-source';
import type { AssistantAvailabilityStatus } from '../hooks/use-assistant-availability';
import { AssistantProviderStatusContext } from '../hooks/use-assistant-provider-status';
import { hostChildWorkspaceTabId } from '../host-child-workspace-tab';
import { useHostChildWorkspaceApps } from '../use-host-child-workspace-apps';

afterEach(() => {
  cleanup();
  __resetWorkspaceTabSelectionStoreForTests();
});

const refused = (): Promise<never> => Promise.reject(new Error('not used by a child tab'));

/** A host whose children answer through `resolveChildThread`; nothing else is in scope. */
function host(
  resolveChildThread: (threadId: string) => Promise<AssistantThreadHostChild>
): AssistantThreadHostCapability & { readonly renderThread: ReturnType<typeof vi.fn> } {
  return {
    createThread: refused,
    deleteThread: refused,
    listThreads: refused,
    ownsThread: refused,
    renameThread: refused,
    renderThread: vi.fn((threadId: string) => <p>{`child view ${threadId}`}</p>),
    resolveChildThread,
    updateThreadBinding: refused,
    workspaceRepository: (history) => history,
  };
}

/** The workspace shell's view of the first child app: its tab label, tint and body. */
function ChildApp() {
  const [app] = useHostChildWorkspaceApps();
  return (
    <section aria-label={app?.label} data-agent-color={app?.tabAppearance?.colorId}>
      {app?.render()}
    </section>
  );
}

/** The host's availability as `host/status` reports an env-only OpenRouter key. */
const hostStatus: AssistantAvailabilityStatus = {
  providers: ['openrouter', 'local'],
  state: 'enabled',
};

function renderTab(
  capability: AssistantThreadHostCapability,
  persona: 'explore' | 'worker',
  status: AssistantAvailabilityStatus = hostStatus
) {
  useWorkspaceTabSelectionStore
    .getState()
    .openApp(hostChildWorkspaceTabId({ persona, threadId: 'child-1' }));
  render(
    <AssistantThreadHostContext.Provider value={capability}>
      <AssistantProviderStatusContext value={status}>
        <ChildApp />
      </AssistantProviderStatusContext>
    </AssistantThreadHostContext.Provider>
  );
}

/** What a child composer's provider discovery starts from. */
function ProviderSourceProbe() {
  return (
    <output aria-label="provider source">{JSON.stringify(useAssistantProviderSource())}</output>
  );
}

const explorer: AssistantThreadHostChild = {
  callSign: 'Cedar-1a2b3c',
  color: 'family:2000:730',
  depth: 1,
  parentRunId: 'parent-run',
  parentThreadId: 'root-1',
  persona: 'explore',
  status: 'idle',
  threadId: 'child-1',
  toolCallId: 'call-1',
};

it('names, tints and mounts a restored child tab only after its host resolves that child', async () => {
  const capability = host(async () => explorer);
  renderTab(capability, 'explore');
  expect(await screen.findByText('child view child-1')).toBeVisible();
  const tab = screen.getByRole('region', { name: 'Cedar-1a2b3c' });
  expect(tab).toHaveAttribute('data-agent-color', 'family:2000:730');
  // The child's own header names it above its conversation.
  expect(screen.getByRole('heading', { name: 'Cedar-1a2b3c' })).toBeVisible();
  expect(capability.renderThread).toHaveBeenCalledWith('child-1', true);
});

it('refuses an address whose persona the committed child does not run', async () => {
  const capability = host(async () => explorer);
  renderTab(capability, 'worker');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The child conversation is missing or does not belong to this workspace.'
  );
  expect(capability.renderThread).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Child conversation' })).toBeVisible();
});

it('shows the host refusal for a thread that is not a host child', async () => {
  const capability = host(() => Promise.reject(new Error('Unknown thread')));
  renderTab(capability, 'explore');
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown thread');
  expect(capability.renderThread).not.toHaveBeenCalled();
});

it('forgets a closed tab’s resolution: the same address reopened asks its host again', async () => {
  const resolve = vi
    .fn<(threadId: string) => Promise<AssistantThreadHostChild>>()
    .mockResolvedValueOnce(explorer)
    .mockRejectedValueOnce(new Error('Unknown thread'));
  const capability = host(resolve);
  renderTab(capability, 'explore');
  expect(await screen.findByText('child view child-1')).toBeVisible();
  // A deleted parent closes the tab; the child is gone from its host.
  const address = hostChildWorkspaceTabId({ persona: 'explore', threadId: 'child-1' });
  act(() => {
    useWorkspaceTabSelectionStore.getState().closeApp(address);
  });
  act(() => {
    useWorkspaceTabSelectionStore.getState().openApp(address);
  });
  // The reopened tab waits for the host's new answer, never showing the old child.
  expect(screen.queryByText('child view child-1')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown thread');
  expect(resolve).toHaveBeenCalledTimes(2);
});

it('seeds the child composer with the providers the host status reports, as the root panel is', async () => {
  const capability = {
    ...host(async () => explorer),
    renderThread: vi.fn(() => <ProviderSourceProbe />),
  };
  renderTab(capability, 'explore');
  const source = await screen.findByRole('status', { name: 'provider source' });
  expect(JSON.parse(source.textContent ?? '')).toEqual({
    kind: 'discovery',
    seeds: ['openrouter', 'local'],
  });
});
