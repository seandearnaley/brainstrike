/**
 * The workspace bar's "Copy path" clipboard write.
 *
 * Routed through the shared clipboard service (never raw navigator): a
 * present-but-broken Electron bridge is surfaced, not silently bypassed —
 * and its failure is rendered, not swallowed.
 */
import { createClipboardService } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';

const logger = createLogger('WorkspaceBarClipboard');
const clipboard = createClipboardService();

export function copyWorkspaceBarPath(path: string): void {
  const failTitle = 'Copy path failed';
  void clipboard
    .writeText(path)
    .then((outcome) => {
      if (outcome.ok) {
        return;
      }
      logger.error(failTitle, { error: outcome.error, path });
      toast({ description: outcome.error, title: failTitle, variant: 'destructive' });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Copy path threw', { error: message, path });
      toast({ description: message, title: failTitle, variant: 'destructive' });
    });
}
