import type { LiveDecisionTransport } from '@brainstrike/assistant-ui';
import { useEffect } from 'react';
import { useDelegatedConversationRoot } from './use-delegated-conversation-root';
import { useDeliverLiveDecision } from './use-deliver-live-decision';
import { hasDesktopAssistantBridge, useSteerActiveRun } from './use-steer-active-run';

/**
 * The desktop host's mid-run controls for the panel: the steer transport
 * (BST-588) and the live decision transport (`POST /assistant/decide`, a
 * decision on a card reaches the RUNNING turn). Both exist only where the
 * desktop assistant server does; the web host has neither and queues a
 * decision behind the run instead. The live transport is also handed to the
 * delegated conversation root so a child view's decision takes the same path
 * as the root card's.
 */
export function useAssistantRunControls(params: {
  readonly getActiveRunId: () => string | null;
  readonly ownerResourceId: string;
  readonly permissionEnforceable: boolean;
  readonly rootThreadId: string | undefined;
}): {
  readonly liveDecisionTransport: LiveDecisionTransport | null;
  readonly steerActiveRun: (() => Promise<boolean>) | undefined;
} {
  const desktop = hasDesktopAssistantBridge();
  const steerActiveRun = useSteerActiveRun(params.getActiveRunId);
  const deliverLiveDecision = useDeliverLiveDecision(
    params.getActiveRunId,
    params.permissionEnforceable
  );
  const liveDecisionTransport = desktop ? deliverLiveDecision : null;
  const delegatedRoot = useDelegatedConversationRoot(params.ownerResourceId, params.rootThreadId);
  useEffect(() => {
    delegatedRoot?.setLiveDecisionTransport(liveDecisionTransport);
    return () => {
      delegatedRoot?.setLiveDecisionTransport(null);
    };
  }, [delegatedRoot, liveDecisionTransport]);
  return { liveDecisionTransport, steerActiveRun: desktop ? steerActiveRun : undefined };
}
