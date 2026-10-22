import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useUnseenDiagnosticsCountMock } = vi.hoisted(() => ({
  useUnseenDiagnosticsCountMock: vi.fn(),
}));

vi.mock('../diagnostics/use-unseen-diagnostics-count', () => ({
  useUnseenDiagnosticsCount: useUnseenDiagnosticsCountMock,
}));

import {
  resetDiagnosticSinkHealthStore,
  useDiagnosticSinkHealthStore,
} from '../diagnostics/diagnostic-sink-health-store';
import {
  resetDiagnosticsSeenStore,
  useDiagnosticsSeenStore,
} from '../diagnostics/diagnostics-seen-store';
import { DiagnosticsStatusItem } from '../status-items/diagnostics-status-item';

function mockUnseenCounts(
  rows: Array<{ errorCount: number; warningCount: number }>,
  error: Error | null = null
) {
  useUnseenDiagnosticsCountMock.mockReturnValue({
    error,
    errorCount: rows[0]?.errorCount ?? 0,
    warningCount: rows[0]?.warningCount ?? 0,
  });
}

describe('DiagnosticsStatusItem', () => {
  beforeEach(() => {
    mockUnseenCounts([{ errorCount: 0, warningCount: 0 }]);
    resetDiagnosticsSeenStore();
    usePanelLayoutStore.setState({ activeTab: 'explorer' });
    window.location.hash = '';
  });

  it('renders nothing when the unseen count is 0', () => {
    render(<DiagnosticsStatusItem />);

    expect(screen.queryByTestId('diagnostics-status-trigger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diagnostics-status-announcement')).not.toBeInTheDocument();
  });

  it('renders singular "error" at count 1', () => {
    mockUnseenCounts([{ errorCount: 1, warningCount: 0 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('1 error');
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      '1 error recorded since launch. Open logging settings'
    );
  });

  it('renders plural "errors" at count 2', () => {
    mockUnseenCounts([{ errorCount: 2, warningCount: 0 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('2 errors');
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      '2 errors recorded since launch. Open logging settings'
    );
  });

  it('labels warning-only rows as warnings rather than errors', () => {
    mockUnseenCounts([{ errorCount: 0, warningCount: 2 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('2 warnings');
    expect(screen.getByTestId('diagnostics-status-item')).not.toHaveTextContent('errors');
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      '2 warnings recorded since launch. Open logging settings'
    );
  });

  it('uses the singular warning label at count 1', () => {
    mockUnseenCounts([{ errorCount: 0, warningCount: 1 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('1 warning');
    expect(screen.getByTestId('diagnostics-status-item')).not.toHaveTextContent('warnings');
  });

  it('reports errors and warnings separately when both are unseen', () => {
    mockUnseenCounts([{ errorCount: 2, warningCount: 3 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('2 errors, 3 warnings');
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      '2 errors and 3 warnings recorded since launch. Open logging settings'
    );
  });

  it('clicking advances the seen watermark, opens settings, and routes to the logging tab', async () => {
    mockUnseenCounts([{ errorCount: 3, warningCount: 0 }]);
    // Pin the pre-click watermark to a known PAST value rather than reading
    // whatever `beforeEach` seeded. `resetDiagnosticsSeenStore()` seeds to
    // `Date.now()` and the click lands microseconds later, so asserting
    // against that seed would need `>=` — which passes even when the click
    // writes nothing at all, making the test vacuous. An hour-old watermark
    // makes strict `>` both meaningful AND immune to same-millisecond flake.
    const beforeClick = Date.now() - 60 * 60 * 1000;
    useDiagnosticsSeenStore.setState({ lastSeenAtMs: beforeClick });
    const user = userEvent.setup();

    render(<DiagnosticsStatusItem />);
    await user.click(screen.getByTestId('diagnostics-status-trigger'));

    expect(useDiagnosticsSeenStore.getState().lastSeenAtMs).toBeGreaterThan(beforeClick);
    expect(usePanelLayoutStore.getState().activeTab).toBe('settings');
    expect(window.location.hash).toBe('#settings/logging');
  });

  it('surfaces a read error honestly instead of silently showing 0', () => {
    mockUnseenCounts([], new Error('live query subscribe failed'));

    render(<DiagnosticsStatusItem />);

    const trigger = screen.getByTestId('diagnostics-status-trigger');
    expect(trigger).toBeInTheDocument();
    expect(screen.getByTestId('diagnostics-status-item')).not.toHaveTextContent('0');
    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent(
      'Diagnostics unavailable'
    );
    expect(trigger).toHaveAttribute(
      'aria-label',
      'Unseen diagnostics count unavailable. Open logging settings'
    );
  });

  it('uses the semantic warning tone for both the counted and error states', () => {
    mockUnseenCounts([{ errorCount: 1, warningCount: 0 }]);
    const { rerender } = render(<DiagnosticsStatusItem />);
    expect(screen.getByTestId('diagnostics-status-item')).toHaveClass('text-warning');

    mockUnseenCounts([], new Error('boom'));
    rerender(<DiagnosticsStatusItem />);
    expect(screen.getByTestId('diagnostics-status-item')).toHaveClass('text-warning');
  });
});

describe('DiagnosticsStatusItem sink health', () => {
  beforeEach(() => {
    resetDiagnosticsSeenStore();
    resetDiagnosticSinkHealthStore();
  });

  // A disabled sink writes NO new rows, so the unseen count sits at 0
  // forever and the chip would render nothing — the status bar silently
  // claiming "no errors" precisely when errors have stopped being
  // recorded. That is the exact failure this feature's own contract text
  // condemns for the Persistent log view, so the chip must not reproduce
  // it. The Settings banner alone is not enough: the user has no reason to
  // open Settings when the status bar says all is well.
  it('surfaces a disabled sink even though the unseen count is 0', () => {
    mockUnseenCounts([{ errorCount: 0, warningCount: 0 }]);
    useDiagnosticSinkHealthStore.getState().markDisabled('disk is full');

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent(
      'Diagnostics not recording'
    );
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      'Diagnostic recording has stopped. Open logging settings'
    );
  });

  it('prefers the disabled-sink label over a stale non-zero count', () => {
    mockUnseenCounts([{ errorCount: 4, warningCount: 0 }]);
    useDiagnosticSinkHealthStore.getState().markDisabled('disk is full');

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent(
      'Diagnostics not recording'
    );
  });
});
