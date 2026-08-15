import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/app-state/stores/panel-layout-store';
import { useEffect } from 'react';

/**
 * Fallback description for routes that never carried one of their own. Kept
 * verbatim from the `<Helmet>` that used to live in `apps/web/src/app/layout.tsx`.
 */
const APP_DESCRIPTION = 'Multi-app dashboard';

interface DocumentMeta {
  readonly description: string;
  readonly title: string;
}

/**
 * Document metadata keyed by the shell route it belongs to. The `explorer` and
 * `settings` strings are the ones the removed `<Helmet>` blocks wrote; the rest
 * previously inherited whichever tab had written last, which is why switching
 * to Git or Terminal used to leave the title reading "Home".
 */
const DOCUMENT_META: Readonly<Record<PanelTab, DocumentMeta>> = {
  browser: { description: APP_DESCRIPTION, title: 'Browser - BrainStrike.ai' },
  explorer: { description: 'BrainStrike.ai Home Dashboard', title: 'BrainStrike.ai - Home' },
  git: { description: APP_DESCRIPTION, title: 'Git - BrainStrike.ai' },
  notes: { description: APP_DESCRIPTION, title: 'Notes - BrainStrike.ai' },
  settings: {
    description: 'Customize your application settings',
    title: 'Settings - BrainStrike.ai',
  },
  terminal: { description: APP_DESCRIPTION, title: 'Terminal - BrainStrike.ai' },
};

/**
 * The single `<meta name="description">` element this hook owns. Reused across
 * description changes so the head never accumulates duplicates; adopted rather
 * than replaced when the host document already ships one.
 */
function resolveDescriptionMeta(): HTMLMetaElement {
  const existing = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (existing) {
    return existing;
  }
  const created = document.createElement('meta');
  created.name = 'description';
  document.head.append(created);
  return created;
}

/**
 * The app's ONLY writer of `document.title` / `<meta name="description">`
 * (BST-1281). Mount it exactly once, at the app root.
 *
 * It replaced `react-helmet-async`, which had per-surface `<Helmet>` writers in
 * the root layout, the context-explorer page and the settings page. That worked
 * only because helmet-async 2.x deduped tags across every mounted instance —
 * and `root-layout-content.tsx` keeps every visited tab mounted (`mountedTabs`),
 * so several of those writers really are alive at the same time. 3.x drops the
 * dedupe (it delegates to React 19's native document metadata, whose behaviour
 * with multiple simultaneous `<title>` tags React documents as undefined), so
 * the per-surface arrangement had no non-deprecated form. One writer keyed on
 * the active route does, and it is pinned by
 * `apps/web/src/app/__tests__/document-title.test.tsx`.
 *
 * Settings is an overlay dialog rather than a route swap, so an open dialog
 * wins over the tab underneath it — the same precedence the old markup got
 * from mounting the settings `<Helmet>` on top of the explorer one.
 */
export function useDocumentTitle(): void {
  const activeTab = usePanelLayoutStore((state) => state.activeTab);
  const settingsOpen = usePanelLayoutStore((state) => state.settingsOpen);
  const { description, title } = DOCUMENT_META[settingsOpen ? 'settings' : activeTab];

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    const meta = resolveDescriptionMeta();
    meta.content = description;
  }, [description]);
}
