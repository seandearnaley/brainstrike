import type React from 'react';
import { AssistantDecisionRecoveryContext } from './assistant-decision-recovery-context';
import { PlanModeExitProvider } from './assistant-tool-suspend-notice';

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

export function AssistantRunContextProviders({
  blocked,
  children,
  onExit,
}: {
  blocked: boolean;
  children: React.ReactNode;
  onExit: (() => void) | null | undefined;
}): React.JSX.Element {
  return (
    <PlanModeExitProvider onExit={onExit}>
      <AssistantDecisionRecoveryProvider blocked={blocked}>
        {children}
      </AssistantDecisionRecoveryProvider>
    </PlanModeExitProvider>
  );
}
