import { useCallback } from 'react';
import type { AssistantThreadRepository } from '../assistant-memory-repository';
import { useAssistantThreadStore } from '../assistant-thread-store';
import {
  type AssistantOperatingRootBinding,
  resolveAssistantOperatingRootBinding,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantThreadRootBindingArgs {
  readonly activeRootCount: number;
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly currentMainRoot?: Omit<AssistantOperatingRootBinding, 'persisted'> | undefined;
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
  readonly threadRootBinding: AssistantOperatingRootBinding | undefined;
}

export function useAssistantThreadRootBinding({
  activeRootCount,
  assistantThreadRepository,
  currentMainRoot,
  memoryResourceId,
  selectedMemoryThreadId,
}: UseAssistantThreadRootBindingArgs): UseAssistantThreadRootBindingResult {
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const selectedThread = selectedMemoryThreadId
    ? threadsByResourceId[memoryResourceId]?.find((thread) => thread.id === selectedMemoryThreadId)
    : undefined;
  const threadRootBinding = resolveAssistantOperatingRootBinding({
    ...(currentMainRoot ? { currentMainRoot } : {}),
    ...(selectedThread?.metadata ? { threadMetadata: selectedThread.metadata } : {}),
  });
  const operatingRoot =
    activeRootCount >= 2 && threadRootBinding
      ? {
          displayName: threadRootBinding.displayName,
          ...(threadRootBinding.path ? { path: threadRootBinding.path } : {}),
        }
      : undefined;
  const persistThreadRootBinding = useCallback(
    async (binding: Omit<AssistantOperatingRootBinding, 'persisted'>): Promise<void> => {
      if (!(assistantThreadRepository && selectedMemoryThreadId)) {
        throw new Error('Cannot bind an assistant thread root without an active thread.');
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
    [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, updateThreadMetadata]
  );

  return { operatingRoot, persistThreadRootBinding, threadRootBinding };
}
