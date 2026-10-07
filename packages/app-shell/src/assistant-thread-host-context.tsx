import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { createContext, type ReactNode, useContext } from 'react';

/** A host app supplies committed thread identity and its connected presentation. */
export interface AssistantThreadHostCapability {
  createThread(resourceId: string): Promise<AssistantMemoryThread>;
  renderThread(threadId: string, isVisible: boolean): ReactNode | undefined;
}
export const AssistantThreadHostContext = createContext<AssistantThreadHostCapability | undefined>(
  undefined
);
export function useAssistantThreadHost(): AssistantThreadHostCapability | undefined {
  return useContext(AssistantThreadHostContext);
}
