import { AlertCircle, CircleDot, Loader2, LockKeyhole } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';
import { TAB_ICON_CLASS_NAME } from './tab-strip-tokens';
import type { TabStatus, TabStripItem } from './types';

const DEFAULT_TAB_STATUS_LABELS: Readonly<Record<TabStatus, string>> = {
  attention: 'needs your input',
  deleted: 'deleted',
  error: 'error',
  loading: 'loading',
  locked: 'needs permission',
  running: 'running',
};

/**
 * Status text for the accessible name: `statusLabel` wins and may stand alone
 * (a mark-owned state with no TabStatus), else the default text for `status`.
 */
export function resolveTabStatusText(
  item: Pick<TabStripItem, 'status' | 'statusLabel'>
): string | null {
  return item.statusLabel ?? (item.status ? DEFAULT_TAB_STATUS_LABELS[item.status] : null);
}

/** Status replaces a plain icon; colour is never the only cue (text rides in the name). */
export function TabStatusIcon({ status }: { readonly status: TabStatus }): ReactElement {
  switch (status) {
    case 'running':
    case 'loading':
      return (
        <Loader2
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'animate-spin motion-reduce:animate-none')}
          data-tab-status={status}
        />
      );
    case 'attention':
      return (
        <CircleDot
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-amber-500')}
          data-tab-status={status}
        />
      );
    case 'locked':
      return (
        <LockKeyhole
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-amber-500')}
          data-tab-status={status}
        />
      );
    case 'error':
    case 'deleted':
      return (
        <AlertCircle
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-destructive')}
          data-tab-status={status}
        />
      );
  }
}
