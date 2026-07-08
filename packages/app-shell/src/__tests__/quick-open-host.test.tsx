import type { QuickOpenFileItem } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Radix Dialog + cmdk need a few DOM APIs happy-dom does not implement.
global.ResizeObserver = class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

const openFileInTab = vi.fn();
const setActiveTab = vi.fn();
const filesRef: { current: QuickOpenFileItem[] } = { current: [] };

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    useIdeFileEditor: () => ({ openFileInTab, registerOpenFileInTab: () => {} }),
    useQuickOpenHotkey: () => {},
  };
});

vi.mock('@brainstrike/preferences/stores/panel-layout-store', () => ({
  usePanelLayoutStore: (selector: (state: { setActiveTab: typeof setActiveTab }) => unknown) =>
    selector({ setActiveTab }),
}));

vi.mock('../use-quick-open-files', () => ({
  useQuickOpenFiles: () => ({ files: filesRef.current, loading: false }),
}));

import { QuickOpenHost } from '../quick-open-host';
import { useQuickOpenStore } from '../stores/quick-open-store';

afterEach(() => {
  vi.clearAllMocks();
  filesRef.current = [];
  useQuickOpenStore.setState({ isOpen: false });
});

describe('QuickOpenHost', () => {
  it('opens the selected file by its root-disambiguated compositeKey and switches to the explorer tab', async () => {
    filesRef.current = [
      {
        compositeKey: 'root-b|@|src/index.ts',
        id: 'b',
        name: 'index.ts',
        path: 'src/index.ts',
        rootLabel: 'Beta',
      },
    ];
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenHost />);

    fireEvent.click(await screen.findByText('index.ts'));

    expect(setActiveTab).toHaveBeenCalledWith('explorer');
    expect(openFileInTab).toHaveBeenCalledTimes(1);
    expect(openFileInTab).toHaveBeenCalledWith('root-b|@|src/index.ts');
  });

  it('reflects the store open state', () => {
    useQuickOpenStore.setState({ isOpen: false });
    render(<QuickOpenHost />);
    expect(screen.queryByText('Go to file…')).toBeNull();
  });
});
