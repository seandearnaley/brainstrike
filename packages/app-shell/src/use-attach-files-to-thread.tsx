/**
 * "Attach to thread" (ADR-0021, BST-2018): files become `@file` mentions
 * appended to the active thread's composer draft, through the composer command
 * store that already owns that draft. The host reads a mention when the
 * message is sent; a file in a live workspace folder outside the thread is
 * attached for that message only, and the notice here offers to add its folder
 * to the thread. The Files selection bar and Search both attach through this.
 */

import { serializeFileMentionDirective } from '@brainstrike/assistant-contract';
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import { createLogger } from '@brainstrike/logging';
import { ToastAction, toast } from '@brainstrike/ui';
import { useCallback } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { MAX_ATTACHED_FILES, type PlanRoot, planAttachment } from './explorer-attach-plan';
import { useOptionalRootIdentity } from './roots/root-identity-context';

const logger = createLogger('AttachFilesToThread');

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

/** Attach explorer files (selection keys) to the active thread; `fileCount` is how many. */
export function useAttachFilesToThread(): (fileKeys: Iterable<string>, fileCount: number) => void {
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const identity = useOptionalRootIdentity();
  const threadId = useActiveAssistantThreadId();
  const requestAdd = useThreadFolderScopeStore((state) => state.requestAdd);

  return useCallback(
    (fileKeys: Iterable<string>, fileCount: number): void => {
      if (!threadId) {
        toast({
          description: 'Open or start a thread, then attach the files again.',
          title: 'No active thread',
          variant: 'destructive',
        });
        return;
      }
      if (fileCount > MAX_ATTACHED_FILES) {
        toast({
          description: `Attach at most ${MAX_ATTACHED_FILES} files at a time; ${plural(fileCount, 'file')} are selected.`,
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
      const plan = planAttachment(fileKeys, {
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
              onClick={() => {
                // The notice speaks for the thread it was raised in, never the one shown now.
                const added = requestAdd({
                  displayName: folder.displayName,
                  path: folder.path,
                  rootId: folder.rootId,
                  threadId,
                });
                if (!added) {
                  toast({
                    description: `This notice belongs to another thread. Open that thread to add ${folder.displayName} to it.`,
                    title: `${folder.displayName} was not added`,
                    variant: 'destructive',
                  });
                }
              }}
            >
              Add to this thread
            </ToastAction>
          ),
          description: `${plural(folder.files, 'file')} from ${folder.displayName}, not in this thread: attached to your next message only. Add the folder to let the agent read its other files.`,
          persistent: true,
          title: `${folder.displayName} is not in this thread`,
        });
      }
    },
    [identity, requestAdd, rootDescriptors, threadId]
  );
}
