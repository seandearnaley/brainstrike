import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { useCallback } from 'react';
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding as resolveDurableAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import {
  type AssistantOperatingRootBinding,
  resolveAssistantOperatingRootBinding,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantThreadRootBindingArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly currentMainRoot?: AssistantOperatingRootCandidate | undefined;
  readonly database: DbHandle | null;
  readonly memoryResourceId: string;
  readonly selectedMemoryThreadId: string | undefined;
}

interface UseAssistantThreadRootBindingResult {
  readonly operatingRoot:
    | {
        readonly displayName: string;
        readonly path?: string | undefined;
      }
    | undefined;
  readonly persistThreadRootBinding: (
    binding: Omit<AssistantOperatingRootBinding, 'persisted'>
  ) => Promise<void>;
  readonly resolveThreadRootBinding: () => Promise<
    Omit<AssistantOperatingRootBinding, 'persisted'> | undefined
  >;
  /**
   * The selected thread's row has not reached the store yet, so its metadata
   * reads as EMPTY. Every WRITE derived from that metadata must be refused
   * while this is true (an "absent" folder set is indistinguishable from a
   * genuinely empty one), which is why it is part of the public result rather
   * than a private detail of the two write helpers below.
   */
  readonly selectedThreadMetadataPending: boolean;
  readonly threadRootBinding: AssistantOperatingRootBinding | undefined;
}

export function useAssistantThreadRootBinding({
  assistantThreadRepository,
  currentMainRoot,
  database,
  memoryResourceId,
  selectedMemoryThreadId,
}: UseAssistantThreadRootBindingArgs): UseAssistantThreadRootBindingResult {
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const selectedThread = selectedMemoryThreadId
    ? threadsByResourceId[memoryResourceId]?.find((thread) => thread.id === selectedMemoryThreadId)
    : undefined;
  const selectedThreadMetadataPending = Boolean(selectedMemoryThreadId && !selectedThread);
  const threadRootBinding = resolveAssistantOperatingRootBinding({
    ...(selectedThread?.metadata ? { threadMetadata: selectedThread.metadata } : {}),
  });
  const displayRootBinding = selectedThreadMetadataPending
    ? undefined
    : (threadRootBinding ?? currentMainRoot);
  // No root-count gate: the workspace bar is ORIENTATION, not disambiguation,
  // so a single-root workspace shows its root too (BST-1397).
  const operatingRoot = displayRootBinding
    ? {
        displayName: displayRootBinding.displayName,
        ...(displayRootBinding.path ? { path: displayRootBinding.path } : {}),
      }
    : undefined;
  const resolveThreadRootBinding = useCallback(async () => {
    if (selectedThreadMetadataPending) {
      throw new Error(
        'Cannot resolve the assistant thread root before the selected thread metadata is loaded.'
      );
    }
    if (threadRootBinding) {
      const { persisted: _persisted, ...binding } = threadRootBinding;
      return binding;
    }
    if (!currentMainRoot) {
      return;
    }
    if (!database) {
      throw new Error(
        'Cannot bind an assistant thread root before the workspace database is ready.'
      );
    }
    return resolveDurableAssistantOperatingRootBinding(database, currentMainRoot);
  }, [currentMainRoot, database, selectedThreadMetadataPending, threadRootBinding]);
  const persistThreadRootBinding = useCallback(
    async (binding: Omit<AssistantOperatingRootBinding, 'persisted'>): Promise<void> => {
      if (!(assistantThreadRepository && selectedMemoryThreadId)) {
        throw new Error('Cannot bind an assistant thread root without an active thread.');
      }
      if (selectedThreadMetadataPending) {
        throw new Error(
          'Cannot persist the assistant thread root before the selected thread metadata is loaded.'
        );
      }
      await updateThreadMetadata(
        assistantThreadRepository,
        memoryResourceId,
        selectedMemoryThreadId,
        {
          operatingRootDisplayName: binding.displayName,
          operatingRootId: binding.rootId,
          ...(binding.path ? { operatingRootPath: binding.path } : {}),
        }
      );
    },
    [
      assistantThreadRepository,
      memoryResourceId,
      selectedMemoryThreadId,
      selectedThreadMetadataPending,
      updateThreadMetadata,
    ]
  );

  return {
    operatingRoot,
    persistThreadRootBinding,
    resolveThreadRootBinding,
    selectedThreadMetadataPending,
    threadRootBinding,
  };
}
