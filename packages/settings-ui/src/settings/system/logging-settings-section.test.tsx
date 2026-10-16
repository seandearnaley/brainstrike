import { DIAGNOSTIC_EVENTS_PURGE_LIMIT } from '@brainstrike/db';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import {
  __resetDiagnosticsRetentionStoreForTests,
  useDiagnosticsRetentionStore,
} from '@brainstrike/app-state/stores/diagnostics-retention-store';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingSettingsSection } from './logging-settings-section';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

// Override only `useToast`; keep every other real export (the purge tests
// observe the toast call, and the real `use-toast.ts` module doesn't render
// into the DOM without a mounted `<Toaster />`).
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ dismiss: vi.fn(), toast: toastMock, toasts: [] }),
}));

beforeEach(() => {
  toastMock.mockReset();
  __resetDiagnosticsRetentionStoreForTests();
});

beforeAll(() => {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserver as unknown as typeof ResizeObserver;
  // JSDOM implements neither of these Radix `Select` interaction APIs.
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

describe('LoggingSettingsSection logs link', () => {
  it('opens the Logs tab and renders no log viewer of its own', async () => {
    const user = userEvent.setup();
    const onOpenLogs = vi.fn();
    render(<LoggingSettingsSection onOpenLogs={onOpenLogs} runtime="browser" />);

    expect(screen.queryByRole('region', { name: 'Log Viewer' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Logs' }));

    expect(onOpenLogs).toHaveBeenCalledTimes(1);
  });

  it('offers no link when the host has no Logs tab', () => {
    render(<LoggingSettingsSection runtime="browser" />);

    expect(screen.queryByRole('button', { name: 'Open Logs' })).not.toBeInTheDocument();
  });
});

describe('LoggingSettingsSection diagnostics retention card', () => {
  it('keeps retention preferences usable and reports deferred enforcement without a database', async () => {
    const user = userEvent.setup();
    render(<LoggingSettingsSection runtime="browser" />);

    expect(screen.getByText('Diagnostics Retention')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /keep events for/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /maximum events/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /purge now/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/these limits apply once the local database is available/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /keep events for/i }));
    await user.click(screen.getByRole('option', { name: '7 days' }));

    await waitFor(() => {
      expect(useDiagnosticsRetentionStore.getState().maxAgeDays).toBe(7);
    });
  });

  it('is present when onPurgeNow is supplied', () => {
    render(<LoggingSettingsSection onPurgeNow={vi.fn(async () => 0)} runtime="browser" />);

    expect(screen.getByText('Diagnostics Retention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /purge now/i })).toBeInTheDocument();
  });

  it('changing the "Keep Events For" select writes maxAgeDays to the store', async () => {
    const user = userEvent.setup();
    render(<LoggingSettingsSection onPurgeNow={vi.fn(async () => 0)} runtime="browser" />);

    await user.click(screen.getByRole('combobox', { name: /keep events for/i }));
    await user.click(screen.getByRole('option', { name: '7 days' }));

    await waitFor(() => {
      expect(useDiagnosticsRetentionStore.getState().maxAgeDays).toBe(7);
    });
  });

  it('changing the "Maximum Events" select writes maxRows to the store', async () => {
    const user = userEvent.setup();
    render(<LoggingSettingsSection onPurgeNow={vi.fn(async () => 0)} runtime="browser" />);

    await user.click(screen.getByRole('combobox', { name: /maximum events/i }));
    await user.click(screen.getByRole('option', { name: /5,?000 events/i }));

    await waitFor(() => {
      expect(useDiagnosticsRetentionStore.getState().maxRows).toBe(5000);
    });
  });

  it('clicking Purge now invokes the callback and toasts the deleted count', async () => {
    const user = userEvent.setup();
    const onPurgeNow = vi.fn(async () => 42);
    render(<LoggingSettingsSection onPurgeNow={onPurgeNow} runtime="browser" />);

    await user.click(screen.getByRole('button', { name: /purge now/i }));

    await waitFor(() => expect(onPurgeNow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Purged 42 diagnostic events.',
          title: 'Diagnostics purged',
        })
      )
    );
  });

  // Pins the no-silent-completion rule: a purge that hits the repository's
  // real per-call limit (DIAGNOSTIC_EVENTS_PURGE_LIMIT, imported from
  // @brainstrike/db rather than hardcoded here) must say more may remain
  // instead of implying the backlog is fully drained. Importing the REAL
  // constant means a future change to the repository's limit fails this
  // test loudly if the section's mirrored threshold drifts out of sync.
  it('says more may remain when the deleted count hits the repository per-call limit', async () => {
    const user = userEvent.setup();
    const onPurgeNow = vi.fn(async () => DIAGNOSTIC_EVENTS_PURGE_LIMIT);
    render(<LoggingSettingsSection onPurgeNow={onPurgeNow} runtime="browser" />);

    await user.click(screen.getByRole('button', { name: /purge now/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Purged ${DIAGNOSTIC_EVENTS_PURGE_LIMIT} diagnostic events (more may remain; run again).`,
          title: 'Diagnostics purged',
        })
      )
    );
  });

  // The companion to the case above, and the half that catches drift in the
  // OTHER direction. The "hits the limit" test only fails if the repository
  // constant DROPS below the mirrored threshold; if it were raised (say to
  // 1000), that test would still pass while the section silently
  // over-warned on every purge of 500+. Pinning `LIMIT - 1` to the plain
  // copy closes that gap: raising the repository constant makes this
  // assertion fail RED.
  it('does not claim more may remain one row below the repository per-call limit', async () => {
    const user = userEvent.setup();
    const belowLimit = DIAGNOSTIC_EVENTS_PURGE_LIMIT - 1;
    const onPurgeNow = vi.fn(async () => belowLimit);
    render(<LoggingSettingsSection onPurgeNow={onPurgeNow} runtime="browser" />);

    await user.click(screen.getByRole('button', { name: /purge now/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: `Purged ${belowLimit} diagnostic events.`,
          title: 'Diagnostics purged',
        })
      )
    );
  });

  it('shows a destructive toast when the purge rejects', async () => {
    const user = userEvent.setup();
    const onPurgeNow = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    render(<LoggingSettingsSection onPurgeNow={onPurgeNow} runtime="browser" />);

    await user.click(screen.getByRole('button', { name: /purge now/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'database unavailable',
          title: 'Failed to purge diagnostic events',
          variant: 'destructive',
        })
      )
    );
  });

  it('disables Purge now while a purge is in flight and re-enables it once it resolves', async () => {
    let resolvePurge: ((count: number) => void) | undefined;
    const onPurgeNow = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolvePurge = resolve;
        })
    );
    const user = userEvent.setup();
    render(<LoggingSettingsSection onPurgeNow={onPurgeNow} runtime="browser" />);

    const purgeButton = screen.getByRole('button', { name: /purge now/i });
    expect(purgeButton).not.toBeDisabled();

    await user.click(purgeButton);

    await waitFor(() => expect(purgeButton).toBeDisabled());
    expect(onPurgeNow).toHaveBeenCalledTimes(1);

    resolvePurge?.(0);

    await waitFor(() => expect(purgeButton).not.toBeDisabled());
  });

  it('re-enables Purge now after a rejected purge', async () => {
    let rejectPurge: ((reason: Error) => void) | undefined;
    const onPurgeNow = vi.fn(
      () =>
        new Promise<number>((_resolve, reject) => {
          rejectPurge = reject;
        })
    );
    const user = userEvent.setup();
    render(<LoggingSettingsSection onPurgeNow={onPurgeNow} runtime="browser" />);

    const purgeButton = screen.getByRole('button', { name: /purge now/i });
    await user.click(purgeButton);

    await waitFor(() => expect(purgeButton).toBeDisabled());

    rejectPurge?.(new Error('database unavailable'));

    await waitFor(() => expect(purgeButton).not.toBeDisabled());
  });
});

describe('LoggingSettingsSection sink-health banner', () => {
  it('renders no banner when the sink is healthy', () => {
    render(<LoggingSettingsSection runtime="browser" sinkHealthReason={null} />);

    expect(screen.queryByTestId('diagnostic-sink-health-banner')).not.toBeInTheDocument();
  });

  it('renders no banner when the prop is omitted entirely', () => {
    render(<LoggingSettingsSection runtime="browser" />);

    expect(screen.queryByTestId('diagnostic-sink-health-banner')).not.toBeInTheDocument();
  });

  it('names the reason and states that capture is stopped until restart', () => {
    render(
      <LoggingSettingsSection
        runtime="browser"
        sinkHealthReason="Failed to insert diagnostic events: disk is full"
      />
    );

    const banner = screen.getByTestId('diagnostic-sink-health-banner');
    expect(banner).toHaveTextContent('Failed to insert diagnostic events: disk is full');
    // The honest-degradation copy (design §4.3): the user must learn that
    // capture STOPPED, not merely that something failed once — an empty
    // Persistent log view otherwise reads as "no errors happened".
    expect(banner).toHaveTextContent(/stopped/i);
    expect(banner).toHaveTextContent(/restart/i);
  });

  it('renders the banner above the general logging card', () => {
    render(<LoggingSettingsSection runtime="browser" sinkHealthReason="sink exploded" />);

    const banner = screen.getByTestId('diagnostic-sink-health-banner');
    const generalCard = screen.getByText('General Logging');
    // Node.compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING (4) means
    // the argument comes AFTER `banner` in document order.
    expect(banner.compareDocumentPosition(generalCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
