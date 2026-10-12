import { ToolApprovalGrantProvider } from '@brainstrike/assistant-ui';
import type { ReactNode } from 'react';
import { useToolApprovalGrantHandlers } from './use-tool-approval-grant-handlers';

/**
 * Everything an approval card needs from the host: the grant actions
 * ("Always allow" / "Allow <category> this session"). A decision queues behind
 * the running turn; no live decision transport exists.
 */
export function AssistantDecisionProviders({ children }: { children: ReactNode }) {
  const grants = useToolApprovalGrantHandlers();
  return <ToolApprovalGrantProvider handlers={grants}>{children}</ToolApprovalGrantProvider>;
}
