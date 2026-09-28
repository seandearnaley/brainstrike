import { appReloadStore } from '@brainstrike/ui';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RunningAssistantRunsState } from '../use-running-assistant-runs';

const { projectionStore } = vi.hoisted(() => {
  const state: RunningAssistantRunsState = { runningCount: 1, status: 'ready' };
  return {
    projectionStore: {
      get: () => state,
      subscribe: () => () => undefined,
    },
  };
});

vi.mock('../use-running-assistant-runs', () => ({
  useRunningAssistantRuns: () =>
    useSyncExternalStore(projectionStore.subscribe, projectionStore.get),
}));

import { AppReloadGate } from '../app-reload-gate';
import { AppReloadStrip } from '../app-reload-strip';

// The reload store is module-level and has no reset: these cases run in order,
// and only the second one marks a reload as required.
describe('AppReloadStrip', () => {
  const reload = vi.fn<() => void>();

  function mountStrip() {
    return render(
      <AppReloadGate buildId="build-1" reload={reload}>
        <AppReloadStrip />
      </AppReloadGate>
    );
  }

  it('renders nothing while no chunk has failed and nothing is pending', () => {
    const { container } = mountStrip();

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the failed-chunk notice, and the pending banner under it once the user chooses to wait', () => {
    mountStrip();
    act(() => appReloadStore.markRequired());

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Reload app' }));
    const dialog = screen.getByRole('dialog', { name: 'Reload BrainStrike?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload when finished' }));

    const notice = screen.getByRole('alert');
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('BrainStrike will reload when the current run finishes.');
    expect(notice.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('fails at mount without an enclosing gate, instead of hiding the button', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<AppReloadStrip />)).toThrow(/AppReload(Provider|Gate)/);
  });
});
