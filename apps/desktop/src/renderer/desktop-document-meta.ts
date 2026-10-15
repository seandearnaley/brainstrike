/**
 * The desktop app's document title and description per shell route, written
 * by the shared `useDocumentTitle` (its one writer, mounted at the desktop
 * root). The Files and Settings strings are the ones their pages wrote with
 * `<title>` elements before; those writers are gone, because every visited
 * route stays mounted and two live `<title>`s left the window title to
 * whichever mounted first.
 */
import type { DocumentMetaByRoute } from '@brainstrike/app-shell/use-document-title';

const PRODUCT = 'BrainStrike Desktop';

export const DESKTOP_DOCUMENT_META: DocumentMetaByRoute = {
  browser: { description: PRODUCT, title: `${PRODUCT} - Browser` },
  explorer: { description: `${PRODUCT} Home Dashboard`, title: `${PRODUCT} - Home` },
  git: { description: PRODUCT, title: `${PRODUCT} - Git` },
  notes: { description: PRODUCT, title: `${PRODUCT} - Notes` },
  settings: { description: `${PRODUCT} Settings`, title: `${PRODUCT} - Settings` },
  terminal: { description: PRODUCT, title: `${PRODUCT} - Terminal` },
};
