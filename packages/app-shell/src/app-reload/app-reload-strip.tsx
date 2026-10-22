import { AppReloadNotice } from '@brainstrike/ui';
import type { ReactElement } from 'react';

/**
 * The persistent top strip for app reloads: the failed-chunk notice. Needs an
 * enclosing `AppReloadGate`.
 */
export function AppReloadStrip(): ReactElement {
  return <AppReloadNotice />;
}
