/**
 * The wrapper half of the thread panel's run-state report (BST-1844). The panel
 * (assistant-ui) reports `thread.isRunning` keyed by the thread it shows; the
 * thread-tab workspace decides close = hide from it. The wrapper must hand its
 * owner's callback straight to the panel: a wrapper-side binding or debounce
 * would let a close land between a run start and its report.
 */
import './assistant-ui-panel-wrapper-test-support';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import {
  delegatedPanelCallbacks,
  loadTestLocalLlmBackend,
} from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper — run-state report', () => {
  test('forwards the owner callback to the panel unchanged', async () => {
    const onRunningChange = vi.fn();
    render(
      <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
        <AssistantUiPanelWrapper
          loadLocalLlmBackend={loadTestLocalLlmBackend}
          memoryResourceId="/tmp/test-workspace"
          memoryThreadId="thread-running"
          onRunningChange={onRunningChange}
          providerKeySources={[{ provider: 'openai', source: 'stored' }]}
        />
      </AssistantProviderSourceProvider>
    );
    await screen.findByTestId('assistant-ui-panel');

    expect(delegatedPanelCallbacks.onRunningChange).toBe(onRunningChange);
  });
});
