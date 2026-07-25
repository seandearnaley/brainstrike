import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { usePGliteDatabaseMock, usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteDatabaseMock: vi.fn(),
  usePGliteLiveQueryMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

import {
  resetDiagnosticsSeenStore,
  useDiagnosticsSeenStore,
} from '../diagnostics/diagnostics-seen-store';
import { DiagnosticsStatusItem } from '../status-items/diagnostics-status-item';

function mockLiveQueryResult(rows: Array<{ count: number }>, error: Error | null = null) {
  usePGliteLiveQueryMock.mockReturnValue({
    error,
    loading: false,
    refresh: vi.fn(),
    rows,
  });
}

describe('DiagnosticsStatusItem', () => {
  beforeEach(() => {
    usePGliteDatabaseMock.mockReset();
    usePGliteLiveQueryMock.mockReset();
    usePGliteDatabaseMock.mockReturnValue({});
    mockLiveQueryResult([{ count: 0 }]);
    resetDiagnosticsSeenStore();
    usePanelLayoutStore.setState({ activeTab: 'explorer', settingsOpen: false });
    window.location.hash = '';
  });

  it('renders nothing when the unseen count is 0', () => {
    render(<DiagnosticsStatusItem />);

    expect(screen.queryByTestId('diagnostics-status-trigger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diagnostics-status-announcement')).not.toBeInTheDocument();
  });

  it('renders singular "error" at count 1', () => {
    mockLiveQueryResult([{ count: 1 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('1 error');
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      '1 error recorded since launch. Open logging settings'
    );
  });

  it('renders plural "errors" at count 2', () => {
    mockLiveQueryResult([{ count: 2 }]);

    render(<DiagnosticsStatusItem />);

    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent('2 errors');
    expect(screen.getByTestId('diagnostics-status-trigger')).toHaveAttribute(
      'aria-label',
      '2 errors recorded since launch. Open logging settings'
    );
  });

  it('clicking advances the seen watermark, opens settings, and routes to the logging tab', async () => {
    mockLiveQueryResult([{ count: 3 }]);
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
    expect(usePanelLayoutStore.getState().settingsOpen).toBe(true);
    expect(window.location.hash).toBe('#settings/logging');
  });

  it('surfaces a query error honestly instead of silently showing 0', () => {
    mockLiveQueryResult([], new Error('live query subscribe failed'));

    render(<DiagnosticsStatusItem />);

    const trigger = screen.getByTestId('diagnostics-status-trigger');
    expect(trigger).toBeInTheDocument();
    expect(screen.getByTestId('diagnostics-status-item')).not.toHaveTextContent('0');
    expect(screen.getByTestId('diagnostics-status-item')).toHaveTextContent(
      'Diagnostics unavailable'
    );
    expect(trigger).toHaveAttribute(
      'aria-label',
      'Unseen error count unavailable. Open logging settings'
    );
  });

  it('uses the amber warning tone for both the counted and error states', () => {
    mockLiveQueryResult([{ count: 1 }]);
    const { rerender } = render(<DiagnosticsStatusItem />);
    expect(screen.getByTestId('diagnostics-status-item')).toHaveClass(
      'text-amber-800',
      'dark:text-amber-300'
    );

    mockLiveQueryResult([], new Error('boom'));
    rerender(<DiagnosticsStatusItem />);
    expect(screen.getByTestId('diagnostics-status-item')).toHaveClass(
      'text-amber-800',
      'dark:text-amber-300'
    );
  });
});
