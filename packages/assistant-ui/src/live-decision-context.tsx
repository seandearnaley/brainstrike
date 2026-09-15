import type { ReactNode } from 'react';
import { LiveDecisionContext, type LiveDecisionTransport } from './live-decision-transport';

/**
 * Mounts the host's live decision transport (`live-decision-transport.ts`
 * holds the contract and `useLiveDecisionTransport`). This file exports only
 * the provider so Fast Refresh keeps its boundary.
 */
export function LiveDecisionProvider({
  transport,
  children,
}: {
  transport: LiveDecisionTransport | null;
  children: ReactNode;
}) {
  return <LiveDecisionContext.Provider value={transport}>{children}</LiveDecisionContext.Provider>;
}
