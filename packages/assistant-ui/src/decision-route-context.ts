import type { CreateAppendMessage } from '@assistant-ui/react';
import { createContext, use } from 'react';
import type { DecisionDispatchOutcome } from './decision-dispatch';

export interface DecisionRoute {
  readonly dispatch: (message: CreateAppendMessage) => Promise<DecisionDispatchOutcome>;
  readonly queueThreadKey: string;
}

export const DecisionRouteContext = createContext<DecisionRoute | null>(null);

export function useDecisionRoute(): DecisionRoute | null {
  return use(DecisionRouteContext);
}
