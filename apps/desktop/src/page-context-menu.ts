import { createLogger } from '@brainstrike/logging';
import { clipboard, Menu, type WebContents } from 'electron';

const logger = createLogger('PageContextMenu');

/** What a right-click reports about the spot it landed on. */
type PageContextMenuParams = Pick<
  Electron.ContextMenuParams,
  | 'dictionarySuggestions'
  | 'editFlags'
  | 'hasImageContents'
  | 'isEditable'
  | 'linkURL'
  | 'mediaType'
  | 'misspelledWord'
>;

interface PageContextMenuActions {
  readonly addToDictionary: (word: string) => void;
  readonly copyImage: () => void;
  readonly copyLink: (url: string) => void;
  readonly replaceMisspelling: (suggestion: string) => void;
}

/**
 * The items a right-click offers, in Chromium's order: spelling, link, image,
 * then the edit commands. Cut, Copy, Paste and Select All are Electron roles,
 * which run Chromium's own editing commands. Empty when nothing applies, so no
 * empty menu opens.
 */
function buildPageContextMenuTemplate(
  params: PageContextMenuParams,
  actions: PageContextMenuActions
): Electron.MenuItemConstructorOptions[] {
  const sections: Electron.MenuItemConstructorOptions[][] = [];
  const { editFlags, misspelledWord } = params;
  if (params.isEditable && misspelledWord !== '') {
    sections.push([
      ...(params.dictionarySuggestions.length > 0
        ? params.dictionarySuggestions.map((suggestion) => ({
            click: () => {
              actions.replaceMisspelling(suggestion);
            },
            label: suggestion,
          }))
        : [{ enabled: false, label: 'No Guesses Found' }]),
      {
        click: () => {
          actions.addToDictionary(misspelledWord);
        },
        label: 'Add to Dictionary',
      },
    ]);
  }
  if (params.linkURL !== '') {
    const { linkURL } = params;
    sections.push([
      {
        click: () => {
          actions.copyLink(linkURL);
        },
        label: 'Copy Link',
      },
    ]);
  }
  if (params.mediaType === 'image' && params.hasImageContents) {
    sections.push([{ click: actions.copyImage, label: 'Copy Image' }]);
  }
  if (params.isEditable) {
    sections.push([
      { enabled: editFlags.canCut, role: 'cut' },
      { enabled: editFlags.canCopy, role: 'copy' },
      { enabled: editFlags.canPaste, role: 'paste' },
      { type: 'separator' },
      { enabled: editFlags.canSelectAll, role: 'selectAll' },
    ]);
  } else if (editFlags.canCopy) {
    sections.push([{ role: 'copy' }]);
  }
  return sections.flatMap((section, index) =>
    index === 0 ? section : [{ type: 'separator' as const }, ...section]
  );
}

/**
 * Electron shows no context menu of its own, so without this a right-click
 * over chat text or the composer does nothing. A surface with its own menu
 * (`ActionContextMenu`) cancels the DOM `contextmenu` event, which suppresses
 * this one, so the two never stack.
 */
export function attachPageContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    const template = buildPageContextMenuTemplate(params, {
      addToDictionary: (word) => {
        if (!webContents.session.addWordToSpellCheckerDictionary(word)) {
          logger.warn('Could not add the word to the spellchecker dictionary');
        }
      },
      copyImage: () => {
        webContents.copyImageAt(params.x, params.y);
      },
      copyLink: (url) => {
        clipboard.writeText(url);
      },
      replaceMisspelling: (suggestion) => {
        webContents.replaceMisspelling(suggestion);
      },
    });
    if (template.length === 0) {
      return;
    }
    // The frame lets macOS offer Writing Tools, AutoFill and Services.
    Menu.buildFromTemplate(template).popup({
      ...(params.frame ? { frame: params.frame } : {}),
      sourceType: params.menuSourceType,
    });
  });
}
