import {
  LiveDecisionProvider,
  type LiveDecisionTransport,
  ToolApprovalGrantProvider,
} from '@brainstrike/assistant-ui';
import type { ReactNode } from 'react';
import { useToolApprovalGrantHandlers } from './use-tool-approval-grant-handlers';

/**
 * Everything an approval card needs from the host: the grant actions
 * ("Always allow" / "Allow <category> this session") and the live decision
 * transport that delivers a decision into the running turn (desktop only;
 * `null` queues behind the run).
 */
export function AssistantDecisionProviders({
  children,
  liveDecision,
}: {
  children: ReactNode;
  liveDecision: LiveDecisionTransport | null;
}) {
  const grants = useToolApprovalGrantHandlers();
  return (
    <ToolApprovalGrantProvider handlers={grants}>
      <LiveDecisionProvider transport={liveDecision}>{children}</LiveDecisionProvider>
    </ToolApprovalGrantProvider>
  );
}
