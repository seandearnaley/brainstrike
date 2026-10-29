import { act } from '@brainstrike/test-utils/react-act';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyDebugBundleButton } from '../copy-debug-bundle-button';
import { type DebugBundleBinding, DebugBundleProvider } from '../debug-bundle-context';

const messagePartsMock = vi.hoisted(() => [] as unknown[]);
const messageStatusMock = vi.hoisted(
  () =>
    ({ reason: undefined, type: undefined }) as {
      reason: string | undefined;
      type: string | undefined;
    }
);

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: { message: unknown }) => unknown) =>
    selector({ message: { parts: messagePartsMock, status: messageStatusMock } }),
}));

function runEventPart(data: Record<string, unknown>): Record<string, unknown> {
  // Full wire shape (BST-978): the inbound guard requires label/timestamp,
  // which production events always carry via createAssistantRunEvent.
  return {
    data: { label: 'Run failed', timestamp: '2026-07-31T00:00:00.000Z', ...data },
    name: 'brainstrike.run-event',
    type: 'data',
  };
}

function wrap(binding: DebugBundleBinding | null, ui: ReactNode) {
  return render(<DebugBundleProvider value={binding}>{ui}</DebugBundleProvider>);
}

const clipboardWriteText = vi.fn();

beforeEach(() => {
  messagePartsMock.length = 0;
  messageStatusMock.reason = undefined;
  messageStatusMock.type = undefined;
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue(undefined);
  // jsdom does not implement navigator.clipboard.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
});

describe('CopyDebugBundleButton', () => {
  // Spies here include `document.createElement` (the download test hands React
  // one shared anchor). The shared vitest setup restores timers but NOT mocks,
  // so restoring in a test body would leak on the first real assertion failure
  // and cascade into unrelated tests.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing without a provider, even with a run.failed part', () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const { container } = render(<CopyDebugBundleButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with a provider but no failure signal', () => {
    const binding: DebugBundleBinding = { buildBundle: vi.fn() };
    const { container } = wrap(binding, <CopyDebugBundleButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is visible with a provider and a run.failed run-event part, and copies the bundle on click', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const bundle = '# BrainStrike Debug Bundle\n\nsome content';
    const buildBundle = vi.fn().mockResolvedValue(bundle);
    wrap({ buildBundle }, <CopyDebugBundleButton />);

    const button = screen.getByTestId('copy-debug-bundle');
    expect(button).toHaveTextContent('Copy debug bundle');

    await userEvent.click(button);

    expect(buildBundle).toHaveBeenCalledWith({ runId: 'run-1' });
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(bundle);
    });
    await waitFor(() => {
      expect(screen.getByTestId('copy-debug-bundle')).toHaveTextContent(/^Copied · \d+ KB$/u);
    });
  });

  it('is visible when the message carries assistant-ui error state (no run.failed part)', () => {
    messageStatusMock.reason = 'error';
    messageStatusMock.type = 'incomplete';
    const binding: DebugBundleBinding = { buildBundle: vi.fn() };
    wrap(binding, <CopyDebugBundleButton />);
    expect(screen.getByTestId('copy-debug-bundle')).toBeInTheDocument();
  });

  it('downloads the bundle as a timestamped Markdown file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T14:32:05.123Z'));
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: '1a2b3c4d-5e6f-7890', status: 'failed' })
    );
    const bundle = '# BrainStrike Debug Bundle\n\nsome content';
    const buildBundle = vi.fn().mockResolvedValue(bundle);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    wrap({ buildBundle }, <CopyDebugBundleButton />);
    const button = screen.getByTestId('download-debug-bundle');

    // Mocked only AFTER render so React's own element creation is untouched.
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await act(async () => {
      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(buildBundle).toHaveBeenCalledWith({ runId: '1a2b3c4d-5e6f-7890' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe('brainstrike-debug-bundle-2026-07-27T14-32-05Z-run-1a2b3c4d.md');
    expect(button).toHaveTextContent(/^Saved · \d+ KB$/u);
    // The copy action stays untouched by the download cycle.
    expect(screen.getByTestId('copy-debug-bundle')).toHaveTextContent('Copy debug bundle');
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it('shows a visible error naming the download action when the binding rejects', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const buildBundle = vi.fn().mockRejectedValue(new Error('db unavailable'));
    wrap({ buildBundle }, <CopyDebugBundleButton />);

    await userEvent.click(screen.getByTestId('download-debug-bundle'));

    expect(await screen.findByText('Download failed: db unavailable')).toBeInTheDocument();
  });

  it('shows a visible error when the binding rejects', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const buildBundle = vi.fn().mockRejectedValue(new Error('db unavailable'));
    wrap({ buildBundle }, <CopyDebugBundleButton />);

    await userEvent.click(screen.getByTestId('copy-debug-bundle'));

    expect(await screen.findByText('Copy failed: db unavailable')).toBeInTheDocument();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });
});

describe('CopyDebugBundleButton — revert timer (pinning regressions)', () => {
  const COPIED_RESET_MS = 3000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not let a stale revert timer clobber a newer copy cycle on rapid double-click', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const buildBundle = vi.fn().mockResolvedValue('# BrainStrike Debug Bundle\n\nsome content');
    wrap({ buildBundle }, <CopyDebugBundleButton />);
    const button = screen.getByTestId('copy-debug-bundle');

    // First click: resolves to "Copied" at fake-time 0 and schedules a
    // revert timer due at t=3000.
    await act(async () => {
      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(button).toHaveTextContent(/^Copied · \d+ KB$/u);

    // Let some time pass before the second click so the two revert timers
    // land at distinct due points.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Second click (t=1000): must cancel the FIRST timer and start its own
    // cycle, due at t=4000.
    await act(async () => {
      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(buildBundle).toHaveBeenCalledTimes(2);
    expect(button).toHaveTextContent(/^Copied · \d+ KB$/u);

    // Advance to the FIRST click's original 3s due point (t=3000): the stale
    // timer must NOT fire — the button must still read the SECOND cycle's
    // "Copied" state, not have reverted to idle early.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(button).toHaveTextContent(/^Copied · \d+ KB$/u);

    // Advance the remaining time for the SECOND cycle's own timer (t=4000).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(button).toHaveTextContent('Copy debug bundle');
  });

  it('clears the pending revert timer on unmount without a setState-after-unmount warning', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const buildBundle = vi.fn().mockResolvedValue('# BrainStrike Debug Bundle\n\nsome content');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { unmount } = wrap({ buildBundle }, <CopyDebugBundleButton />);
    const button = screen.getByTestId('copy-debug-bundle');

    await act(async () => {
      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(button).toHaveTextContent(/^Copied · \d+ KB$/u);

    unmount();

    // If the revert timer were still live, this fires setState on an
    // unmounted component — React (or a strict-mode test harness) surfaces
    // that via console.error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPIED_RESET_MS);
    });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
