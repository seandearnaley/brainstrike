import type { AssistantThreadCatalogRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore, useResourceThread } from '@brainstrike/assistant-data';

import {
  type AssistantOperatingRootBinding,
  resolveAssistantOperatingRootBinding,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantThreadRootBindingArgs {
  readonly assistantThreadRepository: AssistantThreadCatalogRepository | null;
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
  memoryResourceId,
  selectedMemoryThreadId,
}: UseAssistantThreadRootBindingArgs): UseAssistantThreadRootBindingResult {
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  // The new thread's composer reads its draft binding as an unsent thread's.
  const selectedThread = useResourceThread(memoryResourceId, selectedMemoryThreadId);
  const selectedThreadMetadataPending = Boolean(selectedMemoryThreadId && !selectedThread);
  const threadRootBinding = resolveAssistantOperatingRootBinding({
    ...(selectedThread?.metadata ? { threadMetadata: selectedThread.metadata } : {}),
  });
  // A thread's folder is its own binding; an unbound thread has none.
  const displayRootBinding = selectedThreadMetadataPending ? undefined : threadRootBinding;
  // No root-count gate: the workspace bar is ORIENTATION, not disambiguation,
  // so a single-root workspace shows its root too (BST-1397).
  const operatingRoot = displayRootBinding
    ? {
        displayName: displayRootBinding.displayName,
        ...(displayRootBinding.path ? { path: displayRootBinding.path } : {}),
      }
    : undefined;
  const persistThreadRootBinding = async (
    binding: Omit<AssistantOperatingRootBinding, 'persisted'>
  ): Promise<void> => {
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
  };

  return {
    operatingRoot,
    persistThreadRootBinding,
    selectedThreadMetadataPending,
    threadRootBinding,
  };
}
