import type { DbHandle } from '@brainstrike/db';
import { useCallback } from 'react';
import type { AssistantThreadRepository } from '../assistant-memory-repository';
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding as resolveDurableAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import { useAssistantThreadStore } from '../assistant-thread-store';
import {
  type AssistantOperatingRootBinding,
  resolveAssistantOperatingRootBinding,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantThreadRootBindingArgs {
  readonly activeRootCount: number;
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
  readonly threadRootBinding: AssistantOperatingRootBinding | undefined;
}

export function useAssistantThreadRootBinding({
  activeRootCount,
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
  const threadRootBinding = resolveAssistantOperatingRootBinding({
    ...(selectedThread?.metadata ? { threadMetadata: selectedThread.metadata } : {}),
  });
  const displayRootBinding = threadRootBinding ?? currentMainRoot;
  const operatingRoot =
    activeRootCount >= 2 && displayRootBinding
      ? {
          displayName: displayRootBinding.displayName,
          ...(displayRootBinding.path ? { path: displayRootBinding.path } : {}),
        }
      : undefined;
  const resolveThreadRootBinding = useCallback(async () => {
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
  }, [currentMainRoot, database, threadRootBinding]);
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

  return {
    operatingRoot,
    persistThreadRootBinding,
    resolveThreadRootBinding,
    threadRootBinding,
  };
}
