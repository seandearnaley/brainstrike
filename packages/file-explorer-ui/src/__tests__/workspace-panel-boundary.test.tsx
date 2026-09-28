import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { CANVAS_APP, FILES_APP, renderWorkspace } from './workspace-tabs-test-support';

vi.mock('../shell/file-tab-explorer-pane', () => ({
  FileTabExplorerPane: () => <div data-testid="pane-spy" />,
}));

// The real body needs a file system; a stand-in that crashes for one file
// proves the file-body boundary and its compositeKey reset key.
vi.mock('../shell/file-tab-body', () => ({
  FileTabBody: ({ tab }: { readonly tab: { readonly path: string } }) => {
    if (tab.path === 'src/bad.ts') {
      throw new Error('bad.ts cannot render');
    }
    return <div data-testid="file-body">{tab.path}</div>;
  },
}));

vi.mock('../preview/preview-panel', () => ({
  PreviewPanel: vi.fn(() => <div data-testid="preview-panel">PreviewPanel</div>),
}));

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    canLoadWithoutTree: false,
    fileContentErrors: new Map<string, Error>(),
    fileContents: {},
    fileTree: [],
    loadFileContent: vi.fn().mockResolvedValue(undefined),
    loadingFiles: new Set<string>(),
    loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
    rootDirectoryHandle: null,
  })),
}));

vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(() => ({
    effectiveSelection: new Set<string>(),
    handleSelectionChange: vi.fn(),
    selectedFilePaths: new Set<string>(),
    selectedFilesList: [],
    setSelectedFilesFromList: vi.fn(),
    wouldExceedSelectionLimit: vi.fn(() => false),
  })),
}));

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...original,
    useTabFileRestoration: vi.fn(() => ({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>(),
    })),
  };
});

const A = 'folderA|@|src/a.ts';

function openFileTabs(...ids: readonly string[]): void {
  for (const id of ids) {
    useTabManagerStore.getState().openTab(decodeFileSelection(id).path, id, id);
  }
}

function tabNamed(name: RegExp): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('workspace panel error boundaries (TabPanelBoundary)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceTabSelectionStoreForTests();
    __resetTabManagerStoreForTests();
    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab: vi.fn(),
    });
    vi.spyOn(uiModule, 'useUndoableAction').mockReturnValue({
      clearUndoTimeout: vi.fn(),
      performUndoableAction: vi.fn(),
    });
  });

  afterEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
    __resetTabManagerStoreForTests();
  });

  it('contains a crashing app to its panel; the strip and the other apps stay interactive', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let renders = 0;
    let shouldThrow = true;
    function Crashing(): ReactElement {
      renders += 1;
      if (shouldThrow) {
        throw new Error('canvas exploded');
      }
      return <div data-testid="canvas-recovered">Recovered</div>;
    }
    useWorkspaceTabSelectionStore.getState().openApp(CANVAS_APP.id);
    const user = userEvent.setup();
    renderWorkspace([FILES_APP, { ...CANVAS_APP, render: () => <Crashing /> }]);

    const panel = document.getElementById('workspace-app-panel-canvas');
    expect(await within(panel as HTMLElement).findByRole('alert')).toHaveTextContent(
      'Canvas stopped working'
    );
    expect(within(panel as HTMLElement).getByText('canvas exploded')).toBeInTheDocument();

    // The strip still switches tabs, and the other app renders.
    await user.click(tabNamed(/files/i));
    expect(await screen.findByTestId('preview-panel')).toBeVisible();

    // Switching back re-shows the fallback without re-running the crashed app.
    const rendersBeforeReturn = renders;
    await user.click(tabNamed(/canvas/i));
    expect(within(panel as HTMLElement).getByRole('alert')).toBeVisible();
    expect(renders).toBe(rendersBeforeReturn);

    // Reload tab remounts: it re-throws while the app still throws, then recovers.
    await user.click(within(panel as HTMLElement).getByRole('button', { name: /reload tab/i }));
    expect(within(panel as HTMLElement).getByRole('alert')).toBeInTheDocument();
    shouldThrow = false;
    await user.click(within(panel as HTMLElement).getByRole('button', { name: /reload tab/i }));
    expect(await screen.findByTestId('canvas-recovered')).toBeVisible();
    consoleError.mockRestore();
  });

  it('resets the file-body boundary per file: another file renders, the crashing one re-crashes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const BAD = 'folderA|@|src/bad.ts';
    openFileTabs(A, BAD);
    useWorkspaceTabSelectionStore.getState().selectFile(BAD);
    const user = userEvent.setup();
    renderWorkspace();

    const fallback = await screen.findByRole('alert');
    expect(fallback).toHaveTextContent('bad.ts stopped working');
    expect(fallback.closest('[role="tabpanel"]')).toHaveAttribute(
      'id',
      `workspace-file-panel-${BAD}`
    );

    await user.click(tabNamed(/^a\.ts$/));
    expect(await screen.findByTestId('file-body')).toHaveTextContent('src/a.ts');
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(tabNamed(/bad\.ts/));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad.ts stopped working');
    consoleError.mockRestore();
  });
});
