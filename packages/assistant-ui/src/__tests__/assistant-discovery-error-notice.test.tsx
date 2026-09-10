import { useAssistantDataUI } from '@assistant-ui/react';
import { SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME } from '@brainstrike/assistant-contract';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { assistantDiscoveryErrorDataUI } from '../assistant-discovery-error-data-ui';
import { Harness } from './assistant-activity-timeline-fixtures';

function Registration({ children }: { children: ReactNode }) {
  useAssistantDataUI(assistantDiscoveryErrorDataUI);
  return children;
}

describe('pending decision recovery notice', () => {
  it.each(['request-failed', 'invalid-response', 'timed-out'] as const)(
    'renders %s through the shared activity renderer without invoking a model',
    async (reason) => {
      const run = vi.fn(async () => {
        throw new Error('A recovery notice must not invoke a model.');
      });
      render(
        <Harness
          adapter={{ run }}
          initialMessages={[
            {
              content: [
                { text: 'Saved conversation', type: 'text' },
                { data: { reason }, name: SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME, type: 'data' },
              ],
              role: 'assistant',
            },
          ]}
        >
          {(content) => <Registration>{content}</Registration>}
        </Harness>
      );
      expect(await screen.findByText('Saved conversation')).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Pending decisions could not be restored'
      );
      expect(screen.getByRole('alert')).toHaveTextContent('Reopen this thread to check again.');
      expect(screen.getByRole('alert').textContent?.includes('did not respond in time')).toBe(
        reason === 'timed-out'
      );
      expect(run).not.toHaveBeenCalled();
    }
  );

  it('reports malformed recovery data while keeping the conversation visible', async () => {
    const run = vi.fn(async () => {
      throw new Error('A malformed recovery notice must not invoke a model.');
    });
    render(
      <Harness
        adapter={{ run }}
        initialMessages={[
          {
            content: [
              { text: 'Saved conversation', type: 'text' },
              {
                data: { reason: 'success' },
                name: SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME,
                type: 'data',
              },
            ],
            role: 'assistant',
          },
        ]}
      >
        {(content) => <Registration>{content}</Registration>}
      </Harness>
    );
    expect(await screen.findByText('Saved conversation')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Pending decision recovery returned an invalid status'
    );
    expect(run).not.toHaveBeenCalled();
  });
});
