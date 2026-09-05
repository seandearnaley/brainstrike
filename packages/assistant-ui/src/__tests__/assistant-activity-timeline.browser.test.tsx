import '@testing-library/jest-dom/vitest';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { completedParts, Harness } from './assistant-activity-timeline-fixtures';

it.each([400, 800])(
  'paints activity on either side of its text at %i px, including after expansion',
  async (width) => {
    render(
      <div style={{ width }}>
        <Harness
          adapter={{
            async run() {
              throw new Error('A saved transcript must not call a model.');
            },
          }}
          initialMessages={[{ content: completedParts, role: 'assistant' }]}
        />
      </div>
    );
    const text = await screen.findByText('I found the issue.');
    const groups = screen.getAllByTestId('assistant-activity-group');
    const first = groups[0];
    const second = groups[1];
    if (groups.length !== 2 || !first || !second) {
      throw new Error('Expected separate chronological activity groups.');
    }
    const measure = () => ({
      first: first.getBoundingClientRect(),
      second: second.getBoundingClientRect(),
      text: text.getBoundingClientRect(),
    });
    const before = measure();
    expect(before.first.height).toBeGreaterThan(0);
    expect(before.text.height).toBeGreaterThan(0);
    expect(before.second.height).toBeGreaterThan(0);
    expect(before.first.bottom).toBeLessThanOrEqual(before.text.top);
    expect(before.text.bottom).toBeLessThanOrEqual(before.second.top);
    const toolCard = within(first).getByTestId('tool-fallback');
    expect(toolCard).not.toBeVisible();
    const user = userEvent.setup();
    await user.click(within(first).getByRole('button', { name: 'Expand activity' }));
    expect(toolCard).toBeVisible();
    expect(within(toolCard).getByRole('img', { name: 'Completed' })).toBeVisible();
    await user.click(within(first).getByRole('button', { name: 'Show thinking' }));
    expect(within(first).getByText('First reasoning segment.')).toBeVisible();
    const after = measure();
    expect(after.first.height).toBeGreaterThan(before.first.height);
    expect(after.first.bottom).toBeLessThanOrEqual(after.text.top);
    expect(after.text.bottom).toBeLessThanOrEqual(after.second.top);
    expect(first).toHaveAttribute('data-active', 'false');
    expect(second).toHaveAttribute('data-active', 'false');
  }
);
