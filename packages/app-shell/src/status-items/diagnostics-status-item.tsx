import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { useCallback } from 'react';
import { useDiagnosticSinkHealthStore } from '../diagnostics/diagnostic-sink-health-store';
import { useDiagnosticsSeenStore } from '../diagnostics/diagnostics-seen-store';
import { useUnseenDiagnosticsCount } from '../diagnostics/use-unseen-diagnostics-count';

/**
 * Status-bar chip (Flight Recorder P2b Task 3): "background errors become
 * visible". Counts warn+ diagnostic events recorded since the session
 * watermark and links straight to Settings → Logging.
 *
 * Renders nothing at count 0 — no chrome when there is nothing wrong. But
 * "nothing wrong" and "not watching" are different states, and this chip is
 * the only always-visible diagnostics surface, so BOTH ways of not-knowing
 * outrank the count:
 *
 *   - a disabled sink (`disabledReason`) means no new rows are ever written,
 *     so the count would sit at 0 forever and the status bar would silently
 *     claim "no errors" exactly when errors have STOPPED being recorded —
 *     the same failure the contract condemns for the Persistent log view.
 *     The settings banner alone cannot cover this: a user has no reason to
 *     open settings while the status bar looks clean.
 *   - a live-query error is likewise never rendered as 0.
 *
 * Both surface in the same amber warning tone with an honest label. The
 * disabled-sink state outranks a non-zero count too, because that count is
 * frozen and stale — reporting it as live would be its own small lie.
 */

const AMBER_TONE_CLASSNAME = 'text-amber-800 dark:text-amber-300';

function formatCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'error' : 'errors'}`;
}

interface DiagnosticsChipDisplay {
  readonly announcement: string;
  readonly ariaLabel: string;
  readonly visibleLabel: string;
}

function getDisplay(
  count: number,
  error: Error | null,
  sinkDisabledReason: string | null
): DiagnosticsChipDisplay | null {
  if (sinkDisabledReason) {
    return {
      announcement: 'Diagnostics status: diagnostic recording has stopped',
      ariaLabel: 'Diagnostic recording has stopped. Open logging settings',
      visibleLabel: 'Diagnostics not recording',
    };
  }
  if (error) {
    return {
      announcement: 'Diagnostics status: unseen error count unavailable',
      ariaLabel: 'Unseen error count unavailable. Open logging settings',
      visibleLabel: 'Diagnostics unavailable',
    };
  }
  if (count === 0) {
    return null;
  }
  const countLabel = formatCountLabel(count);
  return {
    announcement: `Diagnostics status: ${countLabel} recorded`,
    ariaLabel: `${countLabel} recorded since launch. Open logging settings`,
    visibleLabel: countLabel,
  };
}

export function DiagnosticsStatusItem() {
  const { count, error } = useUnseenDiagnosticsCount();
  const sinkDisabledReason = useDiagnosticSinkHealthStore((state) => state.disabledReason);
  const markAllSeen = useDiagnosticsSeenStore((state) => state.markAllSeen);
  const openSettings = usePanelLayoutStore((state) => state.openSettings);

  const handleClick = useCallback(() => {
    markAllSeen(Date.now());
    openSettings();
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/logging';
    }
  }, [markAllSeen, openSettings]);

  const display = getDisplay(count, error, sinkDisabledReason);
  if (!display) {
    return null;
  }

  return (
    <>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="diagnostics-status-announcement"
        role="status"
      >
        {display.announcement}
      </span>
      <button
        aria-label={display.ariaLabel}
        className="flex h-7 shrink-0 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-sm px-1.5 text-left transition-[background-color,color] duration-150 hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        data-testid="diagnostics-status-trigger"
        onClick={handleClick}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`flex items-center gap-1.5 whitespace-nowrap font-medium ${AMBER_TONE_CLASSNAME}`}
          data-testid="diagnostics-status-item"
        >
          {display.visibleLabel}
        </span>
      </button>
    </>
  );
}
