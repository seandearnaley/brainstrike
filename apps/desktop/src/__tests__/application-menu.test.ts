import { describe, expect, it, vi } from 'vitest';
import { buildFileMenuTemplate } from '../application-file-menu';
import {
  APP_MENU_IDS,
  buildAboutPanelOptions,
  buildFileMenuClosingItems,
  buildHelpMenuTemplate,
  buildMacAppMenuTemplate,
  buildMacWindowMenuTemplate,
  releaseNotesUrl,
} from '../application-menu';

function submenuOf(template: Electron.MenuItemConstructorOptions) {
  const submenu = template.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error('A top-level menu must carry an array submenu');
  }
  return submenu;
}

/** Every item's role, lowercased as Electron reports it, and accelerator. */
function flatten(items: readonly Electron.MenuItemConstructorOptions[]) {
  return items.flatMap((item): { accelerator: string | undefined; role: string | undefined }[] => [
    { accelerator: item.accelerator, role: item.role?.toLowerCase() },
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

const clickedWindow = { id: 5 } as unknown as Electron.BaseWindow;

function click(item: Electron.MenuItemConstructorOptions | undefined): void {
  item?.click?.({} as Electron.MenuItem, clickedWindow, {} as Electron.KeyboardEvent);
}

describe('platform menus', () => {
  const help = {
    includeAbout: true,
    onOpenReleaseNotes: vi.fn(),
    onShowCrashReports: vi.fn(),
    onShowLogs: vi.fn(),
  };
  const menus = [
    buildMacAppMenuTemplate({ appName: 'Brainstrike', onOpenSettings: vi.fn() }),
    buildMacWindowMenuTemplate(),
    buildHelpMenuTemplate(help),
    buildFileMenuTemplate({
      closingItems: buildFileMenuClosingItems(vi.fn()),
      onOpenFolder: vi.fn(),
      onOpenRecentPath: vi.fn(),
      recentPaths: [],
    }),
  ];

  it('leave ⌘/Ctrl+W to the tab chords (BST-1842)', () => {
    const items = flatten(menus);
    for (const role of ['close', 'filemenu', 'windowmenu', 'appmenu']) {
      expect(
        items.map((item) => item.role),
        `menu role "${role}"`
      ).not.toContain(role);
    }
    expect(
      items.filter((item) => /\+W$/iu.test(item.accelerator ?? '')).map((item) => item.accelerator)
    ).toEqual([]);
  });
});

describe('buildMacAppMenuTemplate', () => {
  it('is named for the app and orders About, Settings…, Services, Hide and Quit', () => {
    const template = buildMacAppMenuTemplate({ appName: 'Brainstrike', onOpenSettings: vi.fn() });
    expect(template.label).toBe('Brainstrike');
    expect(submenuOf(template).map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'about',
      'separator',
      'Settings…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
  });

  it('opens Settings with ⌘, in the clicked window', () => {
    const onOpenSettings = vi.fn();
    const settings = submenuOf(
      buildMacAppMenuTemplate({ appName: 'Brainstrike', onOpenSettings })
    ).find((item) => item.id === APP_MENU_IDS.settings);
    expect(settings?.accelerator).toBe('Cmd+,');
    click(settings);
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith(clickedWindow);
  });
});

describe('buildFileMenuClosingItems', () => {
  it('ends File with Settings… on Ctrl+, and then Quit', () => {
    const onOpenSettings = vi.fn();
    const file = submenuOf(
      buildFileMenuTemplate({
        closingItems: buildFileMenuClosingItems(onOpenSettings),
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: [],
      })
    );
    expect(file.slice(-4).map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'separator',
      'Settings…',
      'separator',
      'quit',
    ]);
    const settings = file.find((item) => item.id === APP_MENU_IDS.settings);
    expect(settings?.accelerator).toBe('Ctrl+,');
    click(settings);
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith(clickedWindow);
  });

  it('leaves File unchanged where the app menu holds them', () => {
    const file = submenuOf(
      buildFileMenuTemplate({ onOpenFolder: vi.fn(), onOpenRecentPath: vi.fn(), recentPaths: [] })
    );
    expect(file.map((item) => item.label)).toEqual(['Open Folder…', 'Open Recent']);
  });
});

describe('buildHelpMenuTemplate', () => {
  it('opens the release notes, the logs and the crash reports', () => {
    const onOpenReleaseNotes = vi.fn();
    const onShowCrashReports = vi.fn();
    const onShowLogs = vi.fn();
    const template = buildHelpMenuTemplate({
      includeAbout: false,
      onOpenReleaseNotes,
      onShowCrashReports,
      onShowLogs,
    });
    expect(template.role).toBe('help');
    const items = submenuOf(template);
    expect(items.map((item) => item.label)).toEqual([
      'Release Notes',
      'Show Logs',
      'Show Crash Reports',
    ]);
    click(items.find((item) => item.id === APP_MENU_IDS.releaseNotes));
    expect(onOpenReleaseNotes).toHaveBeenCalledOnce();
    expect(onShowLogs).not.toHaveBeenCalled();
    click(items.find((item) => item.id === APP_MENU_IDS.showLogs));
    expect(onShowLogs).toHaveBeenCalledOnce();
    expect(onShowCrashReports).not.toHaveBeenCalled();
    click(items.find((item) => item.id === APP_MENU_IDS.showCrashReports));
    expect(onShowCrashReports).toHaveBeenCalledOnce();
  });

  it('ends with About where there is no app menu', () => {
    const items = submenuOf(
      buildHelpMenuTemplate({
        includeAbout: true,
        onOpenReleaseNotes: vi.fn(),
        onShowCrashReports: vi.fn(),
        onShowLogs: vi.fn(),
      })
    );
    expect(items.at(-1)?.role).toBe('about');
  });
});

describe('releaseNotesUrl', () => {
  it('names the published release of the running version', () => {
    expect(releaseNotesUrl('0.4.0-beta.2')).toBe(
      'https://github.com/seandearnaley/brainstrike-releases/releases/tag/v0.4.0-beta.2'
    );
  });
});

describe('buildAboutPanelOptions', () => {
  it('shows the name, version, copyright and website', () => {
    expect(buildAboutPanelOptions('Brainstrike', '0.4.0')).toEqual({
      applicationName: 'Brainstrike',
      applicationVersion: '0.4.0',
      copyright: 'Copyright © 2024 BrainStrike contributors',
      website: 'https://brainstrike.ai',
    });
  });
});
