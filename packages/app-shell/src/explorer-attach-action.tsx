/**
 * The Files app's "Attach to thread" bulk action (ADR-0021, BST-2018): the
 * selected files across every root become `@file` mentions in the active
 * thread's composer (see `useAttachFilesToThread`).
 */

import { useSelectionManager } from '@brainstrike/file-explorer-ui/shell';
import { Button, SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS } from '@brainstrike/ui';
import { Paperclip } from 'lucide-react';
import { type ReactElement, useCallback } from 'react';
import { useAttachFilesToThread } from './use-attach-files-to-thread';

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

export function ExplorerAttachAction(): ReactElement {
  // The whole forest: in query mode `selectedFilePaths` is the focused root alone.
  const { forestSelection, selectedCount } = useSelectionManager();
  const attachFiles = useAttachFilesToThread();
  const attach = useCallback(
    () => attachFiles(forestSelection, selectedCount),
    [attachFiles, forestSelection, selectedCount]
  );

  return (
    <Button
      aria-label={`Attach ${plural(selectedCount, 'file')} to the thread`}
      className="gap-1.5 whitespace-nowrap"
      data-testid="explorer-attach-to-thread"
      disabled={selectedCount === 0}
      onClick={attach}
      size="sm"
      type="button"
      variant="secondary"
    >
      <Paperclip aria-hidden="true" className="h-4 w-4" />
      <span className={SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS}>Attach to thread</span>
    </Button>
  );
}
