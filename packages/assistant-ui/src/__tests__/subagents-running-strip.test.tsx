// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act } from '@brainstrike/test-utils/react-act';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SubagentsRunningStrip } from '../subagents-running-strip';

afterEach(cleanup);

const named = (callSigns: readonly string[]) => callSigns.map((callSign) => ({ callSign }));

it('says how many subagents are still working and names each in its colour', () => {
  render(
    <SubagentsRunningStrip
      agents={[
        { callSign: 'Cedar-1a2b3c', colorId: 'emerald' },
        { callSign: 'Fern-4d5e6f', colorId: 'amber' },
        { callSign: 'Aspen-7a8b9c' },
      ]}
      onStop={vi.fn()}
      stoppable={[]}
    />
  );
  const strip = screen.getByRole('status');
  expect(strip).toHaveTextContent('3 subagents running');
  expect(screen.getAllByTestId('subagent-chip').map((chip) => chip.textContent)).toEqual([
    'Cedar-1a2b3c',
    'Fern-4d5e6f',
    'Aspen-7a8b9c',
  ]);
  expect(screen.getByText('Cedar-1a2b3c').closest('[data-agent-color]')).toHaveAttribute(
    'data-agent-color',
    'emerald'
  );
  // The live mark is the shared, reduced-motion-aware thinking mark.
  expect(strip.querySelector('[data-live="true"]')).not.toBeNull();
  // None it could stop or open: it only informs.
  expect(screen.queryByRole('button')).toBeNull();
});

it('opens a subagent’s conversation from its chip', async () => {
  const open = vi.fn();
  render(
    <SubagentsRunningStrip
      agents={[{ callSign: 'Cedar-1a2b3c', colorId: 'emerald', onOpen: open }]}
      onStop={vi.fn()}
      stoppable={[]}
    />
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Go to Cedar-1a2b3c' }));
  expect(open).toHaveBeenCalledTimes(1);
});

it('names a single subagent in the singular', () => {
  render(
    <SubagentsRunningStrip
      agents={named(['Cedar-1a2b3c'])}
      onStop={vi.fn(async () => undefined)}
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
      agents={named(['Cedar-1a2b3c', 'Fern-4d5e6f', 'Aspen-7a8b9c'])}
      onStop={vi.fn(async () => undefined)}
      stoppable={['Cedar-1a2b3c']}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('3 subagents running');
  const stop = screen.getByRole('button', { name: 'Stop 1 running subagent' });
  expect(stop).toHaveAttribute('title', 'Cedar-1a2b3c');
});

it('renders nothing while no subagent works', () => {
  const { container } = render(
    <SubagentsRunningStrip agents={named([])} onStop={vi.fn()} stoppable={[]} />
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
  render(<SubagentsRunningStrip agents={named(owners)} onStop={onStop} stoppable={owners} />);
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

// Codex review on #3719: a Stop spanning two turns can stop one and fail the
// other; the refusal stays while any subagent it was about still runs.
it('keeps a refusal while a subagent it tried to stop still runs', async () => {
  const onStop = vi.fn(async () => {
    throw new Error('The agent host refused one turn’s Stop.');
  });
  const { rerender } = render(
    <SubagentsRunningStrip
      agents={named(['Cedar-1a2b3c', 'Fern-4d5e6f'])}
      onStop={onStop}
      stoppable={['Cedar-1a2b3c', 'Fern-4d5e6f']}
    />
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Stop 2 running subagents' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('refused one turn’s Stop');

  rerender(
    <SubagentsRunningStrip
      agents={named(['Fern-4d5e6f'])}
      onStop={onStop}
      stoppable={['Fern-4d5e6f']}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent('refused one turn’s Stop');
});

// Codex review on #3719: a refusal is about the subagents it tried to stop;
// once they finish, a later, unrelated subagent never shows it.
it('a refusal clears once the subagents it was about are gone', async () => {
  const onStop = vi.fn(async () => {
    throw new Error('The agent host is not connected.');
  });
  const { rerender } = render(
    <SubagentsRunningStrip
      agents={named(['Cedar-1a2b3c'])}
      onStop={onStop}
      stoppable={['Cedar-1a2b3c']}
    />
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Stop 1 running subagent' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not connected.');

  rerender(<SubagentsRunningStrip agents={named([])} onStop={onStop} stoppable={[]} />);
  rerender(
    <SubagentsRunningStrip
      agents={named(['Fern-4d5e6f'])}
      onStop={onStop}
      stoppable={['Fern-4d5e6f']}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('1 subagent running');
  expect(screen.queryByRole('alert')).toBeNull();
});
