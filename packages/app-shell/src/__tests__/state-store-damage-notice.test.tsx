import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  StateHealthCapability,
  StateStoreHealth,
} from '../state-health/state-health-capability';
import { StateStoreDamageNotice } from '../state-health/state-store-damage-notice';

// BST-1880: a damaged state store says so, with both ways to look again.

const DAMAGED: StateStoreHealth = {
  damagedThreads: 2,
  stateDamage: 'row 7 missing from index sqlite_autoindex_run_events_1',
};
const HEALTHY: StateStoreHealth = { damagedThreads: 0, stateDamage: null };

function capability(reads: readonly (StateStoreHealth | Error | null)[]): StateHealthCapability {
  const read = vi.fn<StateHealthCapability['read']>();
  for (const next of reads) {
    if (next instanceof Error) {
      read.mockRejectedValueOnce(next);
    } else {
      read.mockResolvedValueOnce(next);
    }
  }
  return {
    read,
    restartHost: vi.fn<StateHealthCapability['restartHost']>().mockResolvedValue(undefined),
    showDataFolder: vi.fn<StateHealthCapability['showDataFolder']>().mockResolvedValue(undefined),
  };
}

describe('StateStoreDamageNotice', () => {
  it('renders nothing without the capability or for a healthy store', async () => {
    const { container, rerender } = render(<StateStoreDamageNotice capability={null} />);
    expect(container).toBeEmptyDOMElement();

    const healthy = capability([HEALTHY]);
    rerender(<StateStoreDamageNotice capability={healthy} />);
    await waitFor(() => {
      expect(healthy.read).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('state-store-damage-notice')).toBeNull();
  });

  it('says the store opened read-only, with its finding and the unreadable record count', async () => {
    render(<StateStoreDamageNotice capability={capability([DAMAGED])} />);

    const notice = await screen.findByTestId('state-store-damage-notice');
    expect(notice).toHaveTextContent(
      'BrainStrike’s conversation store is damaged, so it opened read-only.'
    );
    expect(notice).toHaveTextContent('Nothing was deleted or replaced.');
    expect(notice).toHaveTextContent(DAMAGED.stateDamage as string);
    expect(notice).toHaveTextContent('2 conversations could not be read.');
  });

  it('checks again by re-reading, and says when it is still damaged', async () => {
    const user = userEvent.setup();
    const store = capability([DAMAGED, DAMAGED]);
    render(<StateStoreDamageNotice capability={store} />);

    await user.click(await screen.findByRole('button', { name: 'Check again' }));

    expect(await screen.findByRole('status')).toHaveTextContent('still damaged.');
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(store.restartHost).not.toHaveBeenCalled();
  });

  it('restarts the agent host, then checks again, and clears once the store is healthy', async () => {
    const user = userEvent.setup();
    const store = capability([DAMAGED, HEALTHY]);
    render(<StateStoreDamageNotice capability={store} />);

    await user.click(await screen.findByRole('button', { name: 'Restart agent host and check' }));

    await waitFor(() => {
      expect(screen.queryByTestId('state-store-damage-notice')).toBeNull();
    });
    expect(store.restartHost).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledTimes(2);
  });

  it('shows a failed restart and keeps the notice', async () => {
    const user = userEvent.setup();
    const store = capability([DAMAGED]);
    vi.mocked(store.restartHost).mockRejectedValueOnce(
      new Error('The agent host was started outside BrainStrike, so it was not restarted.')
    );
    render(<StateStoreDamageNotice capability={store} />);

    await user.click(await screen.findByRole('button', { name: 'Restart agent host and check' }));

    expect(
      await screen.findByText(
        'Couldn’t restart the agent host: The agent host was started outside BrainStrike, so it was not restarted.'
      )
    ).toBeVisible();
    expect(screen.getByTestId('state-store-damage-notice')).toBeVisible();
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it('opens the data folder', async () => {
    const user = userEvent.setup();
    const store = capability([DAMAGED]);
    render(<StateStoreDamageNotice capability={store} />);

    await user.click(await screen.findByRole('button', { name: 'Show data folder' }));

    expect(store.showDataFolder).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a host that cannot report its health, and claims nothing', async () => {
    const older = capability([null]);
    render(<StateStoreDamageNotice capability={older} />);
    await waitFor(() => {
      expect(older.read).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('state-store-damage-notice')).toBeNull();
  });

  it('says it could not check, rather than claiming health, when the read fails', async () => {
    render(<StateStoreDamageNotice capability={capability([new Error('host unreachable')])} />);

    expect(await screen.findByTestId('state-store-damage-notice')).toHaveTextContent(
      'BrainStrike couldn’t check its conversation store: host unreachable'
    );
  });
});
