import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { useCallback } from 'react';
import { useDiagnosticsSeenStore } from '../diagnostics/diagnostics-seen-store';
import { useUnseenDiagnosticsCount } from '../diagnostics/use-unseen-diagnostics-count';

/**
 * Status-bar chip (Flight Recorder P2b Task 3): "background errors become
 * visible". Counts warn+ diagnostic events recorded since the session
 * watermark and links straight to Settings → Logging.
 *
 * Renders nothing at count 0 — no chrome when there is nothing wrong. A
 * query error is NEVER rendered as 0 (that would be a silent "all clear"
 * claim); instead the chip surfaces in the same amber warning tone with an
 * honest "unavailable" label, so a broken count is visibly a problem rather
 * than invisible.
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

function getDisplay(count: number, error: Error | null): DiagnosticsChipDisplay | null {
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
  const markAllSeen = useDiagnosticsSeenStore((state) => state.markAllSeen);
  const openSettings = usePanelLayoutStore((state) => state.openSettings);

  const handleClick = useCallback(() => {
    markAllSeen(Date.now());
    openSettings();
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/logging';
    }
  }, [markAllSeen, openSettings]);

  const display = getDisplay(count, error);
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
