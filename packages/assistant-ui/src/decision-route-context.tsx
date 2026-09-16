import type { CreateAppendMessage } from '@assistant-ui/react';
import { createContext, type ReactNode, use } from 'react';
import type { DecisionDispatchOutcome } from './decision-dispatch';

export interface DecisionRoute {
  readonly dispatch: (message: CreateAppendMessage) => Promise<DecisionDispatchOutcome>;
  readonly queueThreadKey: string;
}

const DecisionRouteContext = createContext<DecisionRoute | null>(null);

export function DecisionRouteProvider({
  children,
  route,
}: {
  readonly children: ReactNode;
  readonly route: DecisionRoute | null;
}) {
  return <DecisionRouteContext.Provider value={route}>{children}</DecisionRouteContext.Provider>;
}

export function useDecisionRoute(): DecisionRoute | null {
  return use(DecisionRouteContext);
}
