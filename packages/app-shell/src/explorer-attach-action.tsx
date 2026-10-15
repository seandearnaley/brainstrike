/**
 * The Files app's "Attach to thread" bulk action (ADR-0021, BST-2018): the
 * selected files become `@file` mentions appended to the active thread's
 * composer draft, through the composer command store that already owns that
 * draft. The host reads a mention when the message is sent; a file in a live
 * workspace folder outside the thread is attached for that message only, and
 * the notice here offers to add its folder to the thread.
 */

import { serializeFileMentionDirective } from '@brainstrike/assistant-contract';
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import {
  useFileExplorerStoreSelector,
  useSelectionManager,
} from '@brainstrike/file-explorer-ui/shell';
import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS,
  ToastAction,
  toast,
} from '@brainstrike/ui';
import { Paperclip } from 'lucide-react';
import { type ReactElement, useCallback } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { MAX_ATTACHED_FILES, type PlanRoot, planAttachment } from './explorer-attach-plan';
import { useOptionalRootIdentity } from './roots/root-identity-context';

const logger = createLogger('ExplorerAttachAction');

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

export function ExplorerAttachAction(): ReactElement {
  const { selectedCount, selectedFilePaths } = useSelectionManager();
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const identity = useOptionalRootIdentity();
  const threadId = useActiveAssistantThreadId();
  const requestAdd = useThreadFolderScopeStore((state) => state.requestAdd);

  const attach = useCallback(() => {
    if (!threadId) {
      toast({
        description: 'Open or start a thread, then attach the files again.',
        title: 'No active thread',
        variant: 'destructive',
      });
      return;
    }
    if (selectedCount > MAX_ATTACHED_FILES) {
      toast({
        description: `Attach at most ${MAX_ATTACHED_FILES} files at a time; ${plural(selectedCount, 'file')} are selected.`,
        title: 'Too many files to attach',
        variant: 'destructive',
      });
      return;
    }
    const scope = useThreadFolderScopeStore.getState().scope;
    const roots: Record<string, PlanRoot> = {};
    for (const [rootId, descriptor] of Object.entries(rootDescriptors)) {
      if (descriptor?.path) {
        roots[rootId] = { displayName: descriptor.displayName, path: descriptor.path };
      }
    }
    const plan = planAttachment(selectedFilePaths, {
      resolveDbRootId: (adapterRootId) => identity?.resolveDbRootId(adapterRootId) ?? null,
      roots,
      threadRootIds: scope?.threadId === threadId ? scope.rootIds : null,
    });
    if (plan.unaddressable > 0) {
      logger.warn('Selected files could not be addressed as mentions', {
        unaddressable: plan.unaddressable,
      });
      toast({
        description: `${plural(plan.unaddressable, 'selected file')} could not be attached: ${plan.unaddressable === 1 ? 'its folder is' : 'their folders are'} not ready in the workspace.`,
        title: 'Some files were not attached',
        variant: 'destructive',
      });
    }
    if (plan.mentions.length === 0) {
      return;
    }
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: plan.mentions.map((mention) => serializeFileMentionDirective(mention)).join(' '),
      threadId,
    });
    for (const folder of plan.outsideFolders) {
      toast({
        action: (
          <ToastAction
            altText={`Add ${folder.displayName} to this thread`}
            onClick={() =>
              requestAdd({
                displayName: folder.displayName,
                path: folder.path,
                rootId: folder.rootId,
              })
            }
          >
            Add to this thread
          </ToastAction>
        ),
        description: `${plural(folder.files, 'file')} from ${folder.displayName}, not in this thread: attached to your next message only. Add the folder to let the agent read its other files.`,
        persistent: true,
        title: `${folder.displayName} is not in this thread`,
      });
    }
  }, [identity, requestAdd, rootDescriptors, selectedCount, selectedFilePaths, threadId]);

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
