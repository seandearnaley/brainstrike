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
      onClearRecents: vi.fn(),
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
      onClearRecents: vi.fn(),
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
    rows[0]?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(onOpenRecentPath).toHaveBeenCalledExactlyOnceWith('/Users/dev/GitHub/brainstrike');
  });

  it('caps the projection and keeps it newest-first', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `/w/repo-${index}`);
    const recent = submenuOf(
      buildFileMenuTemplate({
        onClearRecents: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: paths,
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    // 10 folders + separator + Clear Menu. The ledger cap is 50 (storage
    // hygiene); a 50-row menu is not a menu.
    expect(rows).toHaveLength(12);
    expect(rows[0]?.label).toBe('repo-0');
  });

  it('DISABLES Open Recent when the ledger is empty rather than hiding it', () => {
    // The one sanctioned disabled item in W6: the menu's shape must not
    // change under the user between launches, and "no recent folders yet" is
    // transient state, not a missing capability.
    const recent = submenuOf(
      buildFileMenuTemplate({
        onClearRecents: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: [],
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    expect(recent?.enabled).toBe(false);
    expect(Array.isArray(recent?.submenu) ? recent.submenu : []).toHaveLength(0);
  });

  it('routes Clear Menu to its own dep', () => {
    const onClearRecents = vi.fn();
    const onOpenRecentPath = vi.fn();
    const recent = submenuOf(
      buildFileMenuTemplate({
        onClearRecents,
        onOpenFolder: vi.fn(),
        onOpenRecentPath,
        recentPaths: ['/w/a'],
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    const clear = rows.at(-1);
    expect(clear?.label).toBe('Clear Menu');
    clear?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(onClearRecents).toHaveBeenCalledTimes(1);
    expect(onOpenRecentPath).not.toHaveBeenCalled();
  });
});
