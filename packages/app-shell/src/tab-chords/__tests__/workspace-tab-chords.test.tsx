import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({
  hasClosedTabs: vi.fn(() => true),
  onActivateTab: vi.fn(),
  onCloseTab: vi.fn(),
  onReopenClosedTab: vi.fn(() => Promise.resolve({ ok: true as const })),
  selection: { kind: 'file' as const, tabId: 'root|@|a.ts' },
  tabOrder: [
    { id: 'context-explorer', label: 'Files' },
    { id: 'root|@|a.ts', label: 'a.ts' },
  ],
}));
vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()),
  useWorkspaceTabs: () => workspace,
}));

import { getTabChordStrip, resolveTabChordScope } from '../tab-chord-registry';
import { WorkspaceTabChords } from '../workspace-tab-chords';

describe('WorkspaceTabChords', () => {
  it('registers the workspace strip as the scope for focus in no panel', async () => {
    const view = render(<WorkspaceTabChords />);
    const strip = getTabChordStrip('workspace');

    expect(strip?.getTabs()).toEqual(workspace.tabOrder);
    expect(strip?.getActiveId()).toBe('root|@|a.ts');
    expect(strip?.getPanel()).toBeNull();
    expect(strip?.hasClosedTabs()).toBe(true);
    workspace.hasClosedTabs.mockReturnValueOnce(false);
    expect(strip?.hasClosedTabs()).toBe(false);
    expect(resolveTabChordScope(document.body)).toBe('workspace');
    strip?.activate('context-explorer');
    strip?.close('root|@|a.ts');
    await strip?.reopenClosed();
    expect(workspace.onActivateTab).toHaveBeenCalledWith('context-explorer');
    expect(workspace.onCloseTab).toHaveBeenCalledWith('root|@|a.ts');
    expect(workspace.onReopenClosedTab).toHaveBeenCalledOnce();

    view.unmount();
    expect(getTabChordStrip('workspace')).toBeUndefined();
  });
});
