import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  CHANGES_APP_ID,
  LOGS_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { LogSourceAdapter } from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LogsWorkspacePage } from '../diagnostics/logs-workspace-page';
import { openLogsTab } from '../diagnostics/open-logs-tab';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  useWorkspaceTabSelectionStore.getState().reset();
  usePanelLayoutStore.setState({ activeTab: 'explorer' });
});

describe('Logs workspace tab (BST-1791)', () => {
  it('reads its log source only while it is the shown tab on the explorer route', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const source: LogSourceAdapter = { getInitialRecords: async () => [], subscribe };
    act(() => useWorkspaceTabSelectionStore.getState().openApp(CHANGES_APP_ID));

    render(<LogsWorkspacePage logSource={source} />);
    expect(subscribe).not.toHaveBeenCalled();

    act(() => openLogsTab());
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    // Another rail tab hides the explorer route, which stays mounted.
    act(() => usePanelLayoutStore.getState().openSettings());
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));

    act(() => usePanelLayoutStore.getState().setActiveTab('explorer'));
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));

    act(() => useWorkspaceTabSelectionStore.getState().openApp(CHANGES_APP_ID));
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2));
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('opens onto the Logs tab from another rail tab', () => {
    act(() => usePanelLayoutStore.getState().openSettings());

    act(() => openLogsTab());

    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: LOGS_APP_ID,
      kind: 'app',
    });
  });
});
