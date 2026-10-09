// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { HostChildToolbar, type HostChildToolbarDetails } from '../host-child-toolbar';

afterEach(cleanup);

const details: HostChildToolbarDetails = {
  depth: 2,
  execution: {
    model: 'gpt-5.4',
    modelSettings: { maxOutputTokens: 4096 },
    planMode: false,
    provider: 'openai',
    providerOptions: { openai: { reasoningEffort: 'high' } },
  },
  maxSteps: 12,
  modelId: 'openai::gpt-5.4',
  planMode: false,
  profile: { label: 'Explorer', mode: 'read-only' },
  steps: 3,
  tools: ['read_file', 'grep_search'],
  usage: { inputTokens: 1500, outputTokens: 320 },
};

it('names the admitted persona, its mode and the steps its run has taken', async () => {
  render(<HostChildToolbar details={details} />);
  const trigger = screen.getByRole('button', { name: 'Child details' });
  expect(trigger).toHaveTextContent('Explorer');
  expect(trigger).toHaveTextContent('Read-only');
  expect(within(trigger).getByTestId('child-budget-usage')).toHaveTextContent('steps 3/12');

  await userEvent.click(trigger);
  const popover = screen.getByRole('dialog', { name: 'Child execution details' });
  for (const line of [
    'gpt-5.4',
    'openai',
    'Effort high',
    'Agent mode',
    'Up to 4,096 output tokens',
    'Up to 12 steps',
    'Level 2',
    '2 admitted tools',
  ]) {
    expect(popover).toHaveTextContent(line);
  }
  expect(popover).toHaveTextContent('Input 1.5K tokens');
  expect(popover).toHaveTextContent('Output 320 tokens');
});

it('says when the run’s settings or the admitted persona were not recorded, never guessing', () => {
  const { execution: _execution, ...unreadable } = details;
  const { profile: _profile, ...unprofiled } = details;
  const { rerender } = render(
    <HostChildToolbar details={{ ...unreadable, executionUnreadable: true }} />
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Latest run settings are unavailable.');
  rerender(<HostChildToolbar details={unprofiled} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'This child’s admitted persona was not recorded.'
  );
  expect(screen.queryByRole('button', { name: 'Child details' })).toBeNull();
});
