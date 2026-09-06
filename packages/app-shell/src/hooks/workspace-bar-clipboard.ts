/**
 * The workspace bar's ONE clipboard write path, shared by "Copy path"
 * (`use-workspace-bar.ts`) and "Copy URL" (`use-workspace-bar-forge.ts`).
 *
 * BST-1391 fix round (F4): `onCopyUrl` used to be a bare alias of
 * `onCopyPath` (`const onCopyUrl = onCopyPath;`), so a failed Copy URL
 * toasted "Copy path failed" and logged the URL under a `path` field — a
 * silently wrong diagnostic, never a silently wrong clipboard write. This
 * function is the shared body, parameterized on which field actually failed,
 * so each caller gets its own honest title/log field with no duplicated
 * clipboard logic to drift apart again.
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

export type WorkspaceBarClipboardField = 'path' | 'url';

function fieldLabel(field: WorkspaceBarClipboardField): string {
  return field === 'path' ? 'path' : 'URL';
}

export function copyWorkspaceBarValue(value: string, field: WorkspaceBarClipboardField): void {
  const label = fieldLabel(field);
  const failTitle = `Copy ${label} failed`;
  void clipboard
    .writeText(value)
    .then((outcome) => {
      if (outcome.ok) {
        return;
      }
      logger.error(failTitle, { error: outcome.error, [field]: value });
      toast({ description: outcome.error, title: failTitle, variant: 'destructive' });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Copy ${label} threw`, { error: message, [field]: value });
      toast({ description: message, title: failTitle, variant: 'destructive' });
    });
}
