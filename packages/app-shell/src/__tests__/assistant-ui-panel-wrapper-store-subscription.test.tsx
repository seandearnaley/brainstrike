import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, test } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { loadTestLocalLlmBackend } from './assistant-ui-panel-wrapper-test-support';

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
            loadLocalLlmBackend={loadTestLocalLlmBackend}
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
