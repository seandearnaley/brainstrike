import { useDocumentTitle } from '@brainstrike/app-shell/use-document-title';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ContextExplorerPageContent from '../context-explorer-page-content';
import SettingsPageContent from '../settings/page-content';

/**
 * BST-1281 regression: exactly ONE `<title>` no matter how many tab surfaces
 * are mounted.
 *
 * `packages/app-shell/src/root-layout-content.tsx` keeps every visited tab
 * mounted (`mountedTabs`), the settings route included — so two page
 * components really are alive at once. The
 * old markup gave each of them its own `<Helmet>` and relied on
 * react-helmet-async 2.x deduping the tags across instances. 3.x delegates to
 * React 19's native document metadata, which does not dedupe (React documents
 * the behaviour of multiple simultaneous `<title>` tags as undefined), so that
 * upgrade would have shipped a doubled `<title>` with no test to catch it —
 * exactly the gap called out in docs/dependency-updates-breaking-changes.md.
 *
 * This test pins the replacement contract: page components write no document
 * metadata at all, and the single `useDocumentTitle` writer owns one `<title>`
 * and one `<meta name="description">`.
 */

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  __esModule: true,
  ContextExplorerAppBody: () => <div data-testid="context-explorer-app-body" />,
  FileExplorerProvider: ({ children }: { children: ReactNode }) => children,
  useFileExplorerStoreSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ devInlineFixtureEnabled: false, setDevInlineFixtureEnabled: vi.fn() }),
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useRestoreAccess: vi.fn(() => ({
      beginRestore: vi.fn(),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    })),
  };
});

vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', () => ({
  ModelSelectionPage: () => <div data-testid="model-selection-page-mock" />,
}));

// The real appearance category reaches for ThemeProvider context; this suite is
// about document metadata, not the settings tree.
vi.mock('@brainstrike/settings-ui/settings-category-factories', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/settings-ui/settings-category-factories')>();
  return {
    ...actual,
    createAppearanceSettingsCategory: vi.fn(() => ({
      content: <div data-testid="appearance-category-mock" />,
      description: 'Appearance settings',
      id: 'appearance',
      keywords: ['appearance'],
      title: 'Appearance',
    })),
  };
});

/**
 * The two tab surfaces the shell keeps mounted at the same time, under the one
 * writer that `apps/web/src/app/root-layout-content.tsx` mounts for real.
 */
function TwoMountedTabs() {
  useDocumentTitle();
  return (
    <>
      <div data-testid="explorer-tab">
        <ContextExplorerPageContent />
      </div>
      <div data-testid="settings-tab">
        <SettingsPageContent />
      </div>
    </>
  );
}

describe('web document title (single writer)', () => {
  beforeEach(() => {
    window.location.hash = '';
    act(() => {
      usePanelLayoutStore.setState({ activeTab: 'explorer' });
    });
  });

  afterEach(() => {
    for (const node of document.head.querySelectorAll('title, meta[name="description"]')) {
      node.remove();
    }
  });

  test('renders exactly one title with two tab surfaces mounted simultaneously', () => {
    render(<TwoMountedTabs />);

    const titles = document.head.querySelectorAll('title');
    expect(titles).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.title).toBe('BrainStrike.ai - Home');
  });

  test('still renders exactly one title when the settings route is selected', () => {
    render(<TwoMountedTabs />);

    act(() => {
      usePanelLayoutStore.getState().openSettings();
    });

    expect(document.head.querySelectorAll('title')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.title).toBe('Settings - BrainStrike.ai');
  });

  test('neither page component writes document metadata on its own', () => {
    render(
      <>
        <ContextExplorerPageContent />
        <SettingsPageContent />
      </>
    );

    expect(document.head.querySelectorAll('title')).toHaveLength(0);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(0);
  });
});
