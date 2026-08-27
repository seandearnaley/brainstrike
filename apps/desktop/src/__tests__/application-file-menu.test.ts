import { describe, expect, it, vi } from 'vitest';
import { buildFileMenuTemplate, FILE_MENU_IDS } from '../application-file-menu';

function submenuOf(template: Electron.MenuItemConstructorOptions) {
  const submenu = template.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error('File menu must carry an array submenu');
  }
  return submenu;
}

describe('buildFileMenuTemplate', () => {
  it('labels the menu File and leads with Open Folder…', () => {
    const template = buildFileMenuTemplate({
      onOpenFolder: vi.fn(),
      onOpenRecentPath: vi.fn(),
      recentPaths: [],
    });
    expect(template.label).toBe('File');
    const [openFolder] = submenuOf(template);
    expect(openFolder?.id).toBe(FILE_MENU_IDS.openFolder);
    expect(openFolder?.label).toBe('Open Folder…');
    expect(openFolder?.accelerator).toBe(process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+O');
  });

  it('projects each recent path to a row labelled by its basename', () => {
    const onOpenRecentPath = vi.fn();
    const template = buildFileMenuTemplate({
      onOpenFolder: vi.fn(),
      onOpenRecentPath,
      recentPaths: ['/Users/dev/GitHub/brainstrike', '/Users/dev/notes'],
    });
    const recent = submenuOf(template).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    expect(rows.slice(0, 2).map((row) => row.label)).toEqual(['brainstrike', 'notes']);
    // The full path is the tooltip, so two same-named folders stay tellable
    // apart — the exact ambiguity the workspace bar's recents also faces.
    expect(rows[0]?.toolTip).toBe('/Users/dev/GitHub/brainstrike');
    // Electron's click handler hands the focused window through as the second
    // callback arg; the row forwards BOTH the path and that window, so the
    // consumer can route to the clicked window even when
    // `BrowserWindow.getFocusedWindow()` is null (app not OS-active — the
    // state every programmatic `getMenuItemById(...).click(...)` runs in).
    const clickedWindow = { id: 7 } as unknown as Electron.BaseWindow;
    rows[0]?.click?.({} as Electron.MenuItem, clickedWindow, {} as Electron.KeyboardEvent);
    expect(onOpenRecentPath).toHaveBeenCalledExactlyOnceWith(
      '/Users/dev/GitHub/brainstrike',
      clickedWindow
    );
  });

  it('forwards the click-handler window to onOpenFolder', () => {
    const onOpenFolder = vi.fn();
    const [openFolder] = submenuOf(
      buildFileMenuTemplate({ onOpenFolder, onOpenRecentPath: vi.fn(), recentPaths: [] })
    );
    const clickedWindow = { id: 3 } as unknown as Electron.BaseWindow;
    openFolder?.click?.({} as Electron.MenuItem, clickedWindow, {} as Electron.KeyboardEvent);
    expect(onOpenFolder).toHaveBeenCalledExactlyOnceWith(clickedWindow);
  });

  it('caps the projection and keeps it newest-first', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `/w/repo-${index}`);
    const recent = submenuOf(
      buildFileMenuTemplate({
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: paths,
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    // Just the 10 capped folder rows (no separator, no Clear Menu — BST-1393
    // review finding removed it, see application-file-menu.ts's doc comment).
    // The ledger cap is 50 (storage hygiene); a 50-row menu is not a menu.
    expect(rows).toHaveLength(10);
    expect(rows[0]?.label).toBe('repo-0');
  });

  it('DISABLES Open Recent when the ledger is empty rather than hiding it', () => {
    // The one sanctioned disabled item in W6: the menu's shape must not
    // change under the user between launches, and "no recent folders yet" is
    // transient state, not a missing capability.
    const recent = submenuOf(
      buildFileMenuTemplate({
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: [],
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    expect(recent?.enabled).toBe(false);
    expect(Array.isArray(recent?.submenu) ? recent.submenu : []).toHaveLength(0);
  });
});
