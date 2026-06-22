import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the Terminal surface (and its @xterm/* dependencies) so it only
// loads when the desktop user opens the Terminal tab. The wrapper is rendered
// only when `window.terminal` is present (see root-layout-content.tsx capability
// gate), so there is no isElectron check here — and the web bundle never pulls
// in @xterm.
const TerminalPanel = lazy(() =>
  import('@brainstrike/app-shell/terminal-panel').then((module) => ({
    default: module.TerminalPanel,
  }))
);

export default function TerminalPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Terminal…
        </div>
      }
    >
      <TerminalPanel />
    </Suspense>
  );
}
