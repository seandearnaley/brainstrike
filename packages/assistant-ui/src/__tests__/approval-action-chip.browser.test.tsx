import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ThreadPrimitive,
  useAuiState,
  useLocalRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import type { AssistantToolSuspendRequest } from '@brainstrike/assistant-contract/tool-suspend';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AssistantToolSuspendNotice } from '../assistant-tool-suspend-notice';
import { UserMessage } from '../user-message';

const chatModel: ChatModelAdapter = {
  run: () => Promise.resolve({ content: [], status: { reason: 'stop', type: 'complete' } }),
};

const networkRequest: AssistantToolSuspendRequest = {
  runId: 'run-network-smoke',
  suspendPayload: {
    allowedDomains: ['pypi.org', '*.githubusercontent.com'],
    kind: 'network',
  },
  toolCallId: 'call-network-smoke',
  toolName: 'brainstrike.runPython',
};

function StoredMessageProbe() {
  const lastUserMessage = useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index -= 1) {
      const message = state.thread.messages[index];
      if (message?.role === 'user') {
        return message;
      }
    }
    return null;
  });
  return <output data-testid="stored-message-probe">{JSON.stringify(lastUserMessage)}</output>;
}

function NetworkDecisionHarness() {
  const runtime = useLocalRuntime(chatModel);
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <AssistantToolSuspendNotice data={networkRequest} />
        <ThreadPrimitive.Messages
          components={{
            AssistantMessage: () => null,
            UserMessage,
          }}
        />
        <StoredMessageProbe />
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

function expectCardRemainsVisible(): void {
  expect(screen.getByTestId('assistant-run-python-network-notice')).toBeVisible();
  expect(screen.getByText('pypi.org')).toBeVisible();
  expect(screen.getByText('*.githubusercontent.com')).toBeVisible();
}

describe('run_python network decision lifecycle', () => {
  it('keeps the domain card and stored allow context while replacing the prompt bubble with a chip', async () => {
    const user = userEvent.setup();
    render(<NetworkDecisionHarness />);

    await user.click(screen.getByTestId('run-python-network-domain-pypi.org'));
    await user.click(screen.getByTestId('run-python-network-domain-*.githubusercontent.com'));
    await user.click(screen.getByTestId('run-python-network-allow'));

    expect(await screen.findByText('Allowed internet access')).toBeVisible();
    expect(screen.queryByTestId('assistant-user-message-content')).not.toBeInTheDocument();
    expectCardRemainsVisible();
    expect(screen.getByTestId('stored-message-probe')).toHaveTextContent('You allowed 2 domains.');
    expect(screen.getByTestId('stored-message-probe')).toHaveTextContent('"action":"allow"');
  });

  it('keeps the domain card and stored deny context while replacing the prompt bubble with a chip', async () => {
    const user = userEvent.setup();
    render(<NetworkDecisionHarness />);

    await user.click(screen.getByTestId('run-python-network-deny'));

    expect(await screen.findByText("Didn't allow internet access")).toBeVisible();
    expect(screen.queryByTestId('assistant-user-message-content')).not.toBeInTheDocument();
    expectCardRemainsVisible();
    expect(screen.getByTestId('stored-message-probe')).toHaveTextContent(
      "You didn't allow internet access."
    );
    expect(screen.getByTestId('stored-message-probe')).toHaveTextContent('"action":"deny"');
  });
});
