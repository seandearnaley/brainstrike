import { cycleTab } from '@brainstrike/context-actions/commands';
import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { useEffect } from 'react';
import { matchTabChord, type TabChordEnvironment } from './match-tab-chord';
import { getTabChordStrip, resolveTabChordScope } from './tab-chord-registry';

const logger = createLogger('TabChords');

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
        return;
      }
      event.preventDefault();
      if (action === 'reopen') {
        strip.reopenClosed().then(
          (outcome) => {
            if (!outcome.ok) {
              report(outcome.error);
            }
          },
          (error: unknown) => report(error instanceof Error ? error.message : String(error))
        );
        return;
      }
      cycleTab(strip, action);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [claimWindowChords, isMac, toast]);
}
