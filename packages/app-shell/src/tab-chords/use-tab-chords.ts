import { cycleTab } from '@brainstrike/context-actions/commands';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useEffect } from 'react';
import { matchTabChord, type TabChordEnvironment } from './match-tab-chord';
import { getTabChordStrip, resolveTabChordScope, type TabChordStrip } from './tab-chord-registry';

const logger = createLogger('TabChords');

/**
 * Focus is lost when nothing holds it, or when it sits inside a `hidden` panel:
 * the browser moves focus off a hidden element only at its next rendering step,
 * after animation frames have run. (A removed element drops focus to body at once.)
 */
function isFocusLost(active: Element | null): boolean {
  return active === null || active === document.body || active.closest('[hidden]') !== null;
}

/**
 * Closing, cycling or reopening can unmount or hide the element that had focus
 * (the tab, or the panel it left), dropping focus to body — and the next chord
 * would then act on the workspace. Once the change has rendered, move LOST focus
 * back into the strip: its selected tab, else its tablist (the strip's focus
 * target of last resort). Focus that survived stays put.
 */
function keepFocusInStrip(strip: TabChordStrip): void {
  window.requestAnimationFrame(() => {
    if (!isFocusLost(document.activeElement)) {
      return;
    }
    const panel = strip.getPanel();
    const target =
      panel?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      panel?.querySelector<HTMLElement>('[role="tablist"]');
    target?.focus();
  });
}

/**
 * The one focus-scoped chord router (BST-1842). A chord acts on the strip whose
 * panel contains `document.activeElement`, or the workspace strip when focus is
 * in no panel. Mount once, in the visible-UI root.
 *
 * With no active tab, ⌘W is left to the host. A chord a nearer handler already
 * claimed (`defaultPrevented`) is never taken.
 */
export function useTabChords(environment: TabChordEnvironment): void {
  const { claimWindowChords, isMac } = environment;
  const { toast } = useToast();

  useEffect(() => {
    const report = (error: string): void => {
      logger.error('Reopen Closed Tab failed', { error });
      toast({ description: error, title: 'Reopen Closed Tab', variant: 'destructive' });
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const action = matchTabChord(event, { claimWindowChords, isMac });
      if (action === null) {
        return;
      }
      const strip = getTabChordStrip(resolveTabChordScope(document.activeElement));
      if (!strip) {
        return;
      }
      if (action === 'close') {
        const activeId = strip.getActiveId();
        if (activeId === null) {
          return;
        }
        event.preventDefault();
        strip.close(activeId);
        keepFocusInStrip(strip);
        return;
      }
      event.preventDefault();
      if (action === 'reopen') {
        strip.reopenClosed().then(
          (outcome) => {
            keepFocusInStrip(strip);
            if (!outcome.ok) {
              report(outcome.error);
            }
          },
          (error: unknown) => report(error instanceof Error ? error.message : String(error))
        );
        return;
      }
      cycleTab(strip, action);
      keepFocusInStrip(strip);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [claimWindowChords, isMac, toast]);
}
