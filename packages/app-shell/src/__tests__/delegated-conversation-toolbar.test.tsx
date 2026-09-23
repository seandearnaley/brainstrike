// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantSubagentPreferencesStoreForTests,
  useAssistantSubagentPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import type { DelegatedConversationInsights } from '@brainstrike/db';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { DelegatedConversationToolbar } from '../delegated-conversation-toolbar';

afterEach(() => {
  cleanup();
  __resetAssistantSubagentPreferencesStoreForTests();
});
function insights(
  threadId = 'child',
  allowedToolIds: readonly string[] = ['brainstrike.readWorkspaceFile']
): DelegatedConversationInsights {
  const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
  if (!worker) {
    throw new Error('Missing canonical Worker');
  }
  return {
    budget: null,
    configuration: {
      maxSteps: 8,
      persona: { ...worker, allowedToolIds },
    },
    depth: 1,
    directUsage: null,
    latestExecutionConfiguration: null,
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
it("states the child's level against the depth its turn stored, not today's setting", async () => {
  // The user has since lowered the setting; the turn ran under 7.
  useAssistantSubagentPreferencesStore.setState({
    settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 1 },
  });
  const user = userEvent.setup();
  render(
    <DelegatedConversationToolbar
      insights={{
        status: 'ready',
        value: {
          ...insights(),
          budget: {
            chargedOutputTokens: 0,
            maxChildOutputTokens: 32_768,
            maxDepth: 7,
            maxSteps: 32,
            steps: 0,
            synthesisUsed: false,
          },
          depth: 2,
        },
      }}
      isRunning
    />
  );
  await user.click(screen.getByRole('button', { name: 'Child details' }));
  expect(screen.getByText('Level 2 of 7')).toBeVisible();
});
it('states only the level of a legacy child whose turn stored no budget', async () => {
  const user = userEvent.setup();
  render(
    <DelegatedConversationToolbar insights={{ status: 'ready', value: insights() }} isRunning />
  );
  await user.click(screen.getByRole('button', { name: 'Child details' }));
  expect(screen.getByText('Level 1')).toBeVisible();
  expect(screen.queryByText(/Level 1 of/)).not.toBeInTheDocument();
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

it('shows the latest admitted child execution settings and tools, not a later root selection', async () => {
  const user = userEvent.setup();
  const value = insights('child', ['brainstrike.grepSearch', 'brainstrike.readWorkspaceFile']);
  const latestExecutionConfiguration = {
    execution: {
      model: 'gpt-5.6-sol',
      modelSettings: { maxOutputTokens: 777 },
      permissionPolicy: {
        policies: { edit: 'ask', execute: 'deny', mcp: 'ask', read: 'allow' },
        yolo: false,
      },
      planMode: true,
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'high' } },
    },
    maxSteps: 3,
    persona: { ...BUILT_IN_PERSONAS[0], allowedToolIds: ['brainstrike.readWorkspaceFile'] },
  };
  render(
    <DelegatedConversationToolbar
      insights={{ status: 'ready', value: { ...value, latestExecutionConfiguration } }}
      isRunning={false}
    />
  );
  await user.click(screen.getByRole('button', { name: 'Child details' }));
  expect(screen.getByText('gpt-5.6-sol')).toBeVisible();
  expect(screen.getByText('Effort high')).toBeVisible();
  expect(screen.getByText('Up to 777 output tokens')).toBeVisible();
  expect(screen.getByText(/execute: deny/)).toBeVisible();
  await user.click(screen.getByText('2 admitted tools'));
  expect(screen.getByText('grepSearch')).toBeVisible();
  expect(screen.getByText('readWorkspaceFile')).toBeVisible();
  expect(screen.queryByText('unknown-custom-model')).not.toBeInTheDocument();
});

it('surfaces an invalid latest execution receipt while retaining the original admission', async () => {
  const user = userEvent.setup();
  render(
    <DelegatedConversationToolbar
      insights={{
        status: 'ready',
        value: { ...insights(), latestExecutionConfiguration: { execution: {} } },
      }}
      isRunning={false}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Latest run settings are unavailable. Original admission details are shown.'
  );
  expect(
    screen.queryByText(/expected string|invalid_type|execution.model/u)
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Child details' }));
  expect(screen.getByText('Up to 8 steps')).toBeVisible();
  expect(screen.getByText('1 admitted tool')).toBeVisible();
  expect(screen.getByText('Model unavailable for latest receipt')).toBeVisible();
  expect(screen.queryByText('unknown-custom-model')).not.toBeInTheDocument();
});

it('states steps and output tokens used against the child budget in the header', () => {
  render(
    <DelegatedConversationToolbar
      insights={{
        status: 'ready',
        value: {
          ...insights(),
          budget: {
            chargedOutputTokens: 6100,
            maxChildOutputTokens: 32_768,
            maxDepth: 3,
            maxSteps: 32,
            steps: 12,
            synthesisUsed: false,
          },
        },
      }}
      isRunning
    />
  );
  expect(screen.getByTestId('child-budget-usage')).toHaveTextContent(
    'steps 12/32 · 6.1K tokens / 32.8K tokens'
  );
});

it('says nothing about a budget it does not have', () => {
  render(
    <DelegatedConversationToolbar
      insights={{ status: 'ready', value: insights() }}
      isRunning={false}
    />
  );
  expect(screen.queryByTestId('child-budget-usage')).not.toBeInTheDocument();
});
