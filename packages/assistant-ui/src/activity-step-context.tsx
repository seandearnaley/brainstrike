import { createContext, type ReactNode, use } from 'react';
import type { ActivityStepMeta } from './activity-step-meta';

/**
 * Per-group step facts (see `deriveStepMeta`). The group provides them; the
 * nested cards read their own answer without needing the AUI runtime (which
 * keeps them unit-testable in isolation). Undefined by default: a card
 * rendered outside any group answers "yes, I am the last running step", so a
 * standalone running card still shimmers.
 */
const ActivityStepMetaContext = createContext<ActivityStepMeta | undefined>(undefined);

export function ActivityStepMetaProvider({
  children,
  meta,
}: {
  children: ReactNode;
  meta: ActivityStepMeta;
}): ReactNode {
  return (
    <ActivityStepMetaContext.Provider value={meta}>{children}</ActivityStepMetaContext.Provider>
  );
}

export function useIsLastRunningStep(id: string | undefined): boolean {
  const meta = use(ActivityStepMetaContext);
  if (meta === undefined) {
    return true;
  }
  return id !== undefined && meta.lastRunningId === id;
}
