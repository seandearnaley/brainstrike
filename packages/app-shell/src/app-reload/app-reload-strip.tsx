import { AppReloadNotice } from '@brainstrike/ui';
import type { ReactElement } from 'react';
import { AppReloadPendingBanner } from './app-reload-pending-banner';

/**
 * The persistent top strip for app reloads: the failed-chunk notice and the
 * "reload when finished" banner. Both need an enclosing `AppReloadGate`.
 */
export function AppReloadStrip(): ReactElement {
  return (
    <>
      <AppReloadNotice />
      <AppReloadPendingBanner />
    </>
  );
}
