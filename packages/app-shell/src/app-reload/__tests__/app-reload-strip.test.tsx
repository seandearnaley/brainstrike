import { act } from '@brainstrike/test-utils/react-act';
import { appReloadStore } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('renders nothing while no chunk has failed', () => {
    const { container } = mountStrip();

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the failed-chunk notice once a reload is required', () => {
    mountStrip();
    act(() => appReloadStore.markRequired());

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('fails at mount without an enclosing gate, instead of hiding the button', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => render(<AppReloadStrip />)).toThrow(/AppReload(Provider|Gate)/u);
    } finally {
      consoleError.mockRestore();
    }
  });
});
