import { AlertCircle, CircleDot, Loader2, LockKeyhole } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';
import { TAB_ICON_CLASS_NAME } from './tab-strip-tokens';
import type { TabStatus } from './types';

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
          className={cn(TAB_ICON_CLASS_NAME, 'text-warning')}
          data-tab-status={status}
        />
      );
    case 'locked':
      return (
        <LockKeyhole
          aria-hidden="true"
          className={cn(TAB_ICON_CLASS_NAME, 'text-warning')}
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
