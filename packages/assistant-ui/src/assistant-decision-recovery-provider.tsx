import type React from 'react';
import { AssistantDecisionRecoveryContext } from './assistant-decision-recovery-context';

export function AssistantDecisionRecoveryProvider({
  blocked,
  children,
}: {
  blocked: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <AssistantDecisionRecoveryContext.Provider value={blocked}>
      {children}
    </AssistantDecisionRecoveryContext.Provider>
  );
}
