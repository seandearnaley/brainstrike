import type { ReactNode } from 'react';
import type { ActivityStepMeta } from './activity-step-meta';
import { ActivityStepMetaContext } from './activity-step-meta-context';

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
