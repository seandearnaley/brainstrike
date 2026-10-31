import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Right-clicking page content opens a native menu (Electron shows none of its
 * own): Copy over selected text, the edit commands in a text field, spelling
 * fixes, and Copy Link / Copy Image.
 */
const electron = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('electron', () => ({
  clipboard: { writeText: electron.writeText },
  Menu: { buildFromTemplate: electron.buildFromTemplate },
}));

const { attachPageContextMenu } = await import('../page-context-menu');

type Listener = (event: unknown, params: Electron.ContextMenuParams) => void;

const NO_EDIT: Electron.EditFlags = {
  canCopy: false,
  canCut: false,
  canDelete: false,
  canEditRichly: false,
  canPaste: false,
  canRedo: false,
  canSelectAll: true,
  canUndo: false,
};

function fakePage() {
  const listeners = new Map<string, Listener>();
  const webContents = {
    copyImageAt: vi.fn(),
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
    },
    replaceMisspelling: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn(() => true) },
  };
  attachPageContextMenu(webContents as unknown as Electron.WebContents);
  const frame = { routingId: 1 } as unknown as Electron.WebFrameMain;
  /** Right-clicks at (10, 20) and returns the menu that opened, if any. */
  const rightClick = (params: Partial<Electron.ContextMenuParams>) => {
    electron.buildFromTemplate.mockClear();
    listeners.get('context-menu')?.({}, {
      dictionarySuggestions: [],
      editFlags: NO_EDIT,
      frame,
      hasImageContents: false,
      isEditable: false,
      linkURL: '',
      mediaType: 'none',
      menuSourceType: 'mouse',
      misspelledWord: '',
      selectionText: '',
      x: 10,
      y: 20,
      ...params,
    } as Electron.ContextMenuParams);
    const template = electron.buildFromTemplate.mock.calls[0]?.[0] as
      | Electron.MenuItemConstructorOptions[]
      | undefined;
    return template;
  };
  return { frame, rightClick, webContents };
}

/** Each item as the user reads it: its label, or its role, or `---`. */
function shown(template: Electron.MenuItemConstructorOptions[] | undefined) {
  return template?.map((item) =>
    item.type === 'separator'
      ? '---'
      : `${item.label ?? item.role}${item.enabled === false ? ' (disabled)' : ''}`
  );
}

function clickItem(template: Electron.MenuItemConstructorOptions[] | undefined, label: string) {
  template
    ?.find((item) => item.label === label)
    ?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.buildFromTemplate.mockReturnValue({ popup: electron.popup });
});

describe('the page context menu', () => {
  it('offers Copy over selected text, and opens at the clicked frame', () => {
    const { frame, rightClick } = fakePage();
    const menu = rightClick({ editFlags: { ...NO_EDIT, canCopy: true }, selectionText: 'hello' });
    expect(shown(menu)).toEqual(['copy']);
    expect(electron.popup).toHaveBeenCalledExactlyOnceWith({ frame, sourceType: 'mouse' });
  });

  it('opens nothing over plain content with no selection', () => {
    const { rightClick } = fakePage();
    expect(rightClick({})).toBeUndefined();
    expect(electron.popup).not.toHaveBeenCalled();
  });

  it('offers Cut, Copy, Paste and Select All in a text field, enabled as the field allows', () => {
    const { rightClick } = fakePage();
    const menu = rightClick({
      editFlags: { ...NO_EDIT, canPaste: true },
      isEditable: true,
    });
    expect(shown(menu)).toEqual(['cut (disabled)', 'copy (disabled)', 'paste', '---', 'selectAll']);
  });

  it('offers spelling fixes over a misspelled word, and replaces it or learns it', () => {
    const { rightClick, webContents } = fakePage();
    const params = {
      dictionarySuggestions: ['hello', 'help'],
      editFlags: { ...NO_EDIT, canCopy: true, canCut: true, canPaste: true },
      isEditable: true,
      misspelledWord: 'helo',
    };
    const menu = rightClick(params);
    expect(shown(menu)).toEqual([
      'hello',
      'help',
      'Add to Dictionary',
      '---',
      'cut',
      'copy',
      'paste',
      '---',
      'selectAll',
    ]);
    clickItem(menu, 'help');
    expect(webContents.replaceMisspelling).toHaveBeenCalledExactlyOnceWith('help');
    clickItem(menu, 'Add to Dictionary');
    expect(webContents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledExactlyOnceWith(
      'helo'
    );

    expect(shown(rightClick({ ...params, dictionarySuggestions: [] }))?.slice(0, 2)).toEqual([
      'No Guesses Found (disabled)',
      'Add to Dictionary',
    ]);
  });

  it('copies a link address', () => {
    const { rightClick } = fakePage();
    const menu = rightClick({ linkURL: 'https://example.com/' });
    expect(shown(menu)).toEqual(['Copy Link']);
    clickItem(menu, 'Copy Link');
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('https://example.com/');
  });

  it('copies an image from where it was clicked', () => {
    const { rightClick, webContents } = fakePage();
    const menu = rightClick({ hasImageContents: true, mediaType: 'image' });
    expect(shown(menu)).toEqual(['Copy Image']);
    clickItem(menu, 'Copy Image');
    expect(webContents.copyImageAt).toHaveBeenCalledExactlyOnceWith(10, 20);
  });

  it('keeps Copy for selected link text', () => {
    const { rightClick } = fakePage();
    const menu = rightClick({
      editFlags: { ...NO_EDIT, canCopy: true },
      linkURL: 'https://example.com/',
      selectionText: 'example',
    });
    expect(shown(menu)).toEqual(['Copy Link', '---', 'copy']);
  });
});
