import type {
  AssistantMemoryThread,
  AssistantThreadRepository,
  ThreadWorkspaceRepository,
} from '@brainstrike/assistant-data';
import { createContext, type ReactNode, useContext } from 'react';

/** A host app supplies committed thread identity and its connected presentation. */
export interface AssistantThreadHostCapability {
  createThread(resourceId: string): Promise<AssistantMemoryThread>;
  listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]>;
  renderThread(threadId: string, isVisible: boolean): ReactNode | undefined;
  workspaceRepository(history: ThreadWorkspaceRepository): ThreadWorkspaceRepository;
}
export const AssistantThreadHostContext = createContext<AssistantThreadHostCapability | undefined>(
  undefined
);
export function useAssistantThreadHost(): AssistantThreadHostCapability | undefined {
  return useContext(AssistantThreadHostContext);
}

/** Keep old history in its existing repository and read new roots from their actual owner. */
export function withAssistantThreadHost<Repository extends AssistantThreadRepository>(
  repository: Repository,
  host: AssistantThreadHostCapability | undefined
): Repository {
  if (!host) {
    return repository;
  }
  return {
    ...repository,
    createThread: (resourceId) => host.createThread(resourceId),
    listThreads: async (resourceId) => {
      const [history, current] = await Promise.all([
        repository.listThreads(resourceId),
        host.listThreads(resourceId),
      ]);
      return [...current, ...history];
    },
  };
}
