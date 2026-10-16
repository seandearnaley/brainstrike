// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SubagentsRunningStrip } from '../subagents-running-strip';

afterEach(cleanup);

it('says how many subagents are still working and names them', () => {
  render(<SubagentsRunningStrip owners={['Cedar-1a2b3c', 'Fern-4d5e6f', 'Aspen-7a8b9c']} />);
  const strip = screen.getByRole('status');
  expect(strip).toHaveTextContent('3 subagents running');
  expect(screen.getByText('3 subagents running')).toHaveAttribute(
    'title',
    'Cedar-1a2b3c, Fern-4d5e6f, Aspen-7a8b9c'
  );
  // The live mark is the shared, reduced-motion-aware thinking mark.
  expect(strip.querySelector('[data-live="true"]')).not.toBeNull();
  // Without a Stop of its own (the conversation's run is active), it only informs.
  expect(screen.queryByRole('button')).toBeNull();
});

it('names a single subagent in the singular', () => {
  render(<SubagentsRunningStrip onStop={vi.fn(async () => undefined)} owners={['Cedar-1a2b3c']} />);
  expect(screen.getByRole('status')).toHaveTextContent('1 subagent running');
  expect(screen.getByRole('button', { name: 'Stop 1 running subagent' })).toBeEnabled();
});

it('renders nothing while no subagent works', () => {
  const { container } = render(<SubagentsRunningStrip onStop={vi.fn()} owners={[]} />);
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
  render(<SubagentsRunningStrip onStop={onStop} owners={['Cedar-1a2b3c', 'Fern-4d5e6f']} />);
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
