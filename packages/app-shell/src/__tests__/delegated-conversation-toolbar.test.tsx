// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import type { DelegatedConversationInsights } from '@brainstrike/db';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { DelegatedConversationToolbar } from '../delegated-conversation-toolbar';

afterEach(cleanup);
function insights(threadId = 'child'): DelegatedConversationInsights {
  const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
  if (!worker) {
    throw new Error('Missing canonical Worker');
  }
  return {
    configuration: {
      maxSteps: 8,
      persona: { ...worker, allowedToolIds: ['brainstrike.readWorkspaceFile'] },
    },
    depth: 1,
    directUsage: null,
    latestRun: {
      model: 'unknown-custom-model',
      modelSettings: null,
      provider: 'openai',
      providerOptions: null,
    },
    subtreeUsage: null,
    threadId,
  };
}
it('shows the admitted scope and real run model while keeping uncaptured usage and effort honest', async () => {
  const user = userEvent.setup();
  render(
    <DelegatedConversationToolbar insights={{ status: 'ready', value: insights() }} isRunning />
  );
  await user.click(screen.getByRole('button', { name: 'Child details' }));
  expect(screen.getByText('unknown-custom-model')).toBeVisible();
  expect(screen.getByText('Up to 8 steps')).toBeVisible();
  expect(screen.getByText('Effort not recorded')).toBeVisible();
  expect(screen.getByText(/Current host permissions still apply/)).toBeVisible();
  await user.click(screen.getByText('1 admitted tool'));
  expect(screen.getByText('readWorkspaceFile')).toBeVisible();
  expect(screen.getByText('No captured usage yet')).toBeVisible();
  expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
});
it('uses the ordinary usage renderer for separate direct and inclusive totals without pricing an unknown model', async () => {
  const user = userEvent.setup();
  const value = insights();
  const row = {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
    inputTokens: 10,
    model: 'unknown-custom-model',
    outputTokens: 2,
    provider: 'openai',
    runKind: 'subagent' as const,
  };
  const directUsage = { perModel: [row], totalInputTokens: 10, totalOutputTokens: 2 };
  const subtreeUsage = {
    perModel: [row, { ...row, inputTokens: 30, outputTokens: 4 }],
    totalInputTokens: 40,
    totalOutputTokens: 6,
  };
  const view = render(
    <DelegatedConversationToolbar
      insights={{ status: 'ready', value: { ...value, directUsage, subtreeUsage } }}
      isRunning={false}
    />
  );
  await user.click(screen.getByRole('button', { name: 'Child details' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('This child · 12 tokens')).toBeVisible();
  expect(within(dialog).getByText('Child and descendants · 46 tokens')).toBeVisible();
  expect(within(dialog).getAllByText('cost unavailable')).toHaveLength(2);
  expect(within(dialog).getByText(/Includes this child; do not add these totals/)).toBeVisible();
  view.rerender(
    <DelegatedConversationToolbar
      insights={{ status: 'ready', value: insights('sibling') }}
      isRunning={false}
    />
  );
  expect(screen.queryByText('This child · 12 tokens')).not.toBeInTheDocument();
});
it('surfaces load and legacy configuration failures without replacing them with another profile', () => {
  const view = render(
    <DelegatedConversationToolbar
      insights={{ error: new Error('Owned child details could not be loaded.'), status: 'error' }}
      isRunning={false}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Owned child details could not be loaded.');
  view.rerender(
    <DelegatedConversationToolbar
      insights={{ status: 'ready', value: { ...insights(), configuration: {} } }}
      isRunning={false}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Start a new delegation');
  expect(screen.queryByText('Worker')).not.toBeInTheDocument();
});
