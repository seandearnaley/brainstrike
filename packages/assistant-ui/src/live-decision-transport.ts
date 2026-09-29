import type { CreateAppendMessage } from '@assistant-ui/react';
import { createContext, use } from 'react';

/**
 * Deliver a decision message INTO the running root turn (desktop
 * `POST /assistant/decide`). `'delivered'` means the host applied it to the
 * live leg and the card's answer will arrive on the stream; `'no-live-run'`
 * means no running leg owns that decision (it settled, or the decision is
 * not a parked background child) and the caller must take the ordinary
 * append path. Any other failure rejects: the host refused the decision or
 * the resume failed, and the card must say so.
 */
export type LiveDecisionTransport = (
  message: CreateAppendMessage
) => Promise<'delivered' | 'no-live-run'>;

/**
 * Provided by `LiveDecisionProvider` (`live-decision-context.tsx`).
 * Component-free so the provider file keeps its Fast Refresh boundary
 * (react-refresh `only-export-components`).
 */
export const LiveDecisionContext = createContext<LiveDecisionTransport | null>(null);

/** The live decision transport, or `null` when the host has none (web). */
export function useLiveDecisionTransport(): LiveDecisionTransport | null {
  return use(LiveDecisionContext);
}
