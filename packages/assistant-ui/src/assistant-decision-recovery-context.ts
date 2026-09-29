import { createContext, use } from 'react';

export const AssistantDecisionRecoveryContext = createContext(false);

export function useAssistantDecisionRecoveryBlocked(): boolean {
  return use(AssistantDecisionRecoveryContext);
}
