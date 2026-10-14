import { use } from 'react';
import { type ActivityGroupView, ActivityGroupViewContext } from './activity-group-view-context';

/** The enclosing activity group's layout, or undefined for a standalone card. */
export function useActivityGroupView(): ActivityGroupView | undefined {
  return use(ActivityGroupViewContext);
}
