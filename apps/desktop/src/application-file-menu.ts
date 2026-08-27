import path from 'node:path';

/**
 * The File submenu (BST-1393, spec §7). Pure and dependency-free so it is the
 * unit under test — labels, accelerators, ids, the recents projection and the
 * click routing — without importing `main.ts`'s ~850-line boot closure.
 *
 * Only THIS submenu is extracted (ruling M1): the other three close over
 * `logger`, `noteNextWindowReload`, `resetDesktopDatabaseProfile` and a
 * module-level in-flight flag, and extracting them would be a refactor of a
 * hot file for zero W6 coverage.
 *
 * Ids exist so a desktop E2E can drive the items through
 * `Menu.getApplicationMenu().getMenuItemById(...)` — the application menu is
 * not reachable from Playwright's page context.
 */
export const FILE_MENU_IDS = {
  openFolder: 'file-open-folder',
  openRecent: 'file-open-recent',
} as const;

/**
 * How many ledger entries the menu shows. `RECENT_ROOTS_LIMIT` is 50 —
 * deliberately far above realistic mount counts so connected roots cannot
 * evict disconnected grants — which is a storage bound, not a menu bound.
 */
export const FILE_MENU_RECENT_LIMIT = 10;

export interface FileMenuDeps {
  readonly onClearRecents: () => void;
  readonly onOpenFolder: () => void;
  readonly onOpenRecentPath: (recentPath: string) => void;
  /** Newest-first, exactly as `listRecentRootEntries` orders them. */
  readonly recentPaths: readonly string[];
}

export function buildFileMenuTemplate({
  onClearRecents,
  onOpenFolder,
  onOpenRecentPath,
  recentPaths,
}: FileMenuDeps): Electron.MenuItemConstructorOptions {
  const visible = recentPaths.slice(0, FILE_MENU_RECENT_LIMIT);
  const recentSubmenu: Electron.MenuItemConstructorOptions[] =
    visible.length === 0
      ? []
      : [
          ...visible.map((recentPath) => ({
            click: () => {
              onOpenRecentPath(recentPath);
            },
            // Basename reads; the full path disambiguates two same-named
            // folders without making every row a wall of text.
            label: path.basename(recentPath) || recentPath,
            toolTip: recentPath,
          })),
          { type: 'separator' as const },
          {
            click: () => {
              onClearRecents();
            },
            label: 'Clear Menu',
          },
        ];

  return {
    label: 'File',
    submenu: [
      {
        // Matches the repo's explicit per-platform accelerator style; the
        // existing View items are written the same way rather than CmdOrCtrl.
        accelerator: process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+O',
        click: () => {
          onOpenFolder();
        },
        id: FILE_MENU_IDS.openFolder,
        label: 'Open Folder…',
      },
      {
        // Disabled, not hidden: an empty ledger is transient state, and a menu
        // whose shape changes between launches is worse than a greyed row.
        enabled: recentSubmenu.length > 0,
        id: FILE_MENU_IDS.openRecent,
        label: 'Open Recent',
        submenu: recentSubmenu,
      },
    ],
  };
}
