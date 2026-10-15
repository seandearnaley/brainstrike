import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import {
  __resetPermissionPolicyStoreForTests,
  usePermissionPolicyStore,
} from '@brainstrike/app-state/stores/permission-policy-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';

/**
 * BST-1645.
 *
 * The wrapper is a ~1,900-line composition module. A `useAssistantPreferencesStore()`
 * call with NO selector subscribes to the whole store: zustand hands the raw
 * state object to `useSyncExternalStoreWithSelector` and compares it with
 * `Object.is`, so every `set(...)` — even one that touches a field the wrapper
 * never reads — produces a new object and re-renders the entire panel.
 *
 * `modelsByProvider` is exactly such a field: the store writes it on every
 * `setModel`, and nothing in the wrapper reads it. `recentModels` — written by
 * the same action, and selected by the wrapper — is the control. Both writes
 * publish a fresh object, so the only thing separating them is whether the
 * wrapper subscribes to that field.
 */
describe('AssistantUiPanelWrapper store subscription', () => {
  afterEach(() => {
    __resetPermissionPolicyStoreForTests();
  });

  const renderCountingPanel = async () => {
    let commits = 0;

    render(
      <Profiler
        id="assistant-panel"
        onRender={() => {
          commits += 1;
        }}
      >
        <AssistantProviderSourceProvider
          source={{ kind: 'authoritative', providers: ['openai'] as SupportedProvider[] }}
        >
          <AssistantUiPanelWrapper
            providerKeySources={[{ provider: 'openai', source: 'stored' }]}
          />
        </AssistantProviderSourceProvider>
      </Profiler>
    );

    await screen.findByTestId('provider-select');
    await waitFor(() => {
      expect(commits).toBeGreaterThan(0);
    });

    // Drain until the panel stops committing on its own. Mount-time probes
    // resolve over several macrotasks, and a late one landing mid-measurement
    // would be miscounted as a reaction to the store write.
    for (let previous = -1; previous !== commits; ) {
      previous = commits;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    return {
      commitsSince: (run: () => void) => {
        const before = commits;
        act(() => {
          run();
        });
        return commits - before;
      },
    };
  };

  test('does not re-render when a preferences field it never reads changes', async () => {
    const panel = await renderCountingPanel();

    const commits = panel.commitsSince(() => {
      useAssistantPreferencesStore.setState({ modelsByProvider: { openai: 'gpt-5.2' } });
    });

    expect(commits).toBe(0);
  });

  /**
   * BST-1652.
   *
   * Tool approval is the HITL path: "Always allow <tool>" and "Allow
   * <category> this session" are recorded into the permission-policy store by
   * the grant handlers the wrapper hands to `ToolApprovalGrantProvider`, in
   * the SAME synchronous handler that then approves the pending call and
   * resumes the run.
   *
   * The renderer's permission snapshot has exactly ONE producer:
   * `prepareRequestData` (use-assistant-request-lifecycle.ts) reads the live
   * store via `getPermissionToolGateSnapshotInput()` at request-composition
   * time and unconditionally overwrites `requestData.permissionPolicyRequest`
   * — precisely so a grant reaches THIS run without waiting for a re-render
   * (its own suite pins that: "permission-policy freshness at the
   * request-composition seam"). A render-time subscription therefore cannot
   * change any bytes on the wire; all it can do is re-render the whole panel
   * — including the streaming message list — at the moment the user is
   * unblocking a paused run.
   */
  test('does not re-render when a session permission grant is recorded', async () => {
    const panel = await renderCountingPanel();

    const commits = panel.commitsSince(() => {
      usePermissionPolicyStore.getState().grantSessionCategory('execute');
    });

    expect(commits).toBe(0);
  });

  test('does not re-render when a per-tool permission override is recorded', async () => {
    const panel = await renderCountingPanel();

    const commits = panel.commitsSince(() => {
      usePermissionPolicyStore.getState().setToolOverride('brainstrike.executeCommand', 'allow');
    });

    expect(commits).toBe(0);
  });

  // The control: the counter must be able to see a re-render, otherwise the
  // assertion above would pass on a broken instrument.
  test('still re-renders when a preferences field it does read changes', async () => {
    const panel = await renderCountingPanel();

    const commits = panel.commitsSince(() => {
      useAssistantPreferencesStore.setState({ recentModels: ['openai::gpt-5.2'] });
    });

    expect(commits).toBeGreaterThan(0);
  });
});
