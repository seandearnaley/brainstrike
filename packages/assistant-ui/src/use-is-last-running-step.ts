import { use } from 'react';
import { ActivityStepMetaContext } from './activity-step-meta-context';

export function useIsLastRunningStep(id: string | undefined): boolean {
  const meta = use(ActivityStepMetaContext);
  if (meta === undefined) {
    return true;
  }
  return id !== undefined && meta.lastRunningId === id;
}
