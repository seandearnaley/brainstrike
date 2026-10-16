// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SubagentsRunningStrip } from '../subagents-running-strip';

afterEach(cleanup);

it('says how many subagents are still working and names them', () => {
  render(
    <SubagentsRunningStrip
      onStop={vi.fn()}
      owners={['Cedar-1a2b3c', 'Fern-4d5e6f', 'Aspen-7a8b9c']}
      stoppable={[]}
    />
  );
  const strip = screen.getByRole('status');
  expect(strip).toHaveTextContent('3 subagents running');
  expect(screen.getByText('3 subagents running')).toHaveAttribute(
    'title',
    'Cedar-1a2b3c, Fern-4d5e6f, Aspen-7a8b9c'
  );
  // The live mark is the shared, reduced-motion-aware thinking mark.
  expect(strip.querySelector('[data-live="true"]')).not.toBeNull();
  // None it could stop (the conversation's running turn owns them): it only informs.
  expect(screen.queryByRole('button')).toBeNull();
});

it('names a single subagent in the singular', () => {
  render(
    <SubagentsRunningStrip
      onStop={vi.fn(async () => undefined)}
      owners={['Cedar-1a2b3c']}
      stoppable={['Cedar-1a2b3c']}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('1 subagent running');
  expect(screen.getByRole('button', { name: 'Stop 1 running subagent' })).toBeEnabled();
});

// Codex review on #3719: a child from an earlier turn keeps running under the
// conversation's next turn, whose Stop does not end it.
it('offers Stop for the subagents the running turn does not own, and names them', () => {
  render(
    <SubagentsRunningStrip
      onStop={vi.fn(async () => undefined)}
      owners={['Cedar-1a2b3c', 'Fern-4d5e6f', 'Aspen-7a8b9c']}
      stoppable={['Cedar-1a2b3c']}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('3 subagents running');
  const stop = screen.getByRole('button', { name: 'Stop 1 running subagent' });
  expect(stop).toHaveAttribute('title', 'Cedar-1a2b3c');
});

it('renders nothing while no subagent works', () => {
  const { container } = render(
    <SubagentsRunningStrip onStop={vi.fn()} owners={[]} stoppable={[]} />
  );
  expect(container).toBeEmptyDOMElement();
});

it('stops them once, says so while the host stops them, and shows a refusal', async () => {
  let settle: (() => void) | undefined;
  let refuse: ((cause: Error) => void) | undefined;
  const onStop = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
  const owners = ['Cedar-1a2b3c', 'Fern-4d5e6f'];
  render(<SubagentsRunningStrip onStop={onStop} owners={owners} stoppable={owners} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Stop 2 running subagents' }));
  const stopping = screen.getByRole('button', { name: 'Stop 2 running subagents' });
  expect(stopping).toBeDisabled();
  expect(stopping).toHaveTextContent('Stopping…');
  await user.click(stopping);
  expect(onStop).toHaveBeenCalledTimes(1);

  await act(async () => refuse?.(new Error('The agent host is not connected.')));
  expect(screen.getByRole('alert')).toHaveTextContent('The agent host is not connected.');
  await user.click(screen.getByRole('button', { name: 'Stop 2 running subagents' }));
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => settle?.());
  expect(onStop).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Stop 2 running subagents' })).toBeEnabled();
});

// Codex review on #3719: a refusal is about the subagents it tried to stop;
// once they finish, a later, unrelated subagent never shows it.
it('a refusal clears once the subagents it was about are gone', async () => {
  const onStop = vi.fn(async () => {
    throw new Error('The agent host is not connected.');
  });
  const { rerender } = render(
    <SubagentsRunningStrip onStop={onStop} owners={['Cedar-1a2b3c']} stoppable={['Cedar-1a2b3c']} />
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Stop 1 running subagent' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not connected.');

  rerender(<SubagentsRunningStrip onStop={onStop} owners={[]} stoppable={[]} />);
  rerender(
    <SubagentsRunningStrip onStop={onStop} owners={['Fern-4d5e6f']} stoppable={['Fern-4d5e6f']} />
  );
  expect(screen.getByRole('status')).toHaveTextContent('1 subagent running');
  expect(screen.queryByRole('alert')).toBeNull();
});
