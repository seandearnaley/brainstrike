/**
 * BST-1990 PR 3: a checked file in a workspace folder outside the selected
 * thread's folders says so on its card, and can ask the thread to add the
 * folder — one request, applied by the workspace bar's own write.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview/preview-panel';
import { useThreadFolderScopeStore } from '../thread-folder-scope-store';

vi.mock('../preview/use-preview-panel-state', async () => {
  const { createUsePreviewPanelStateMock } = await import('./__mocks__/preview-panel-mocks');
  return createUsePreviewPanelStateMock();
});

vi.mock('@brainstrike/ui', async () => {
  const { createUiModuleMock } = await import('./__mocks__/preview-panel-mocks');
  return createUiModuleMock();
});

vi.mock('@brainstrike/hooks', async () => {
  const { createHooksModuleMock } = await import('./__mocks__/preview-panel-mocks');
  return createHooksModuleMock();
});

vi.mock('lucide-react', async () => {
  const { createLucideModuleMock } = await import('./__mocks__/preview-panel-mocks');
  return createLucideModuleMock();
});

const mockUsePreviewPanelState = vi.mocked(
  await import('../preview/use-preview-panel-state')
).usePreviewPanelState;
const { resetPreviewPanelPaginationMockState } = await import('./__mocks__/preview-panel-mocks');

const FOLDERS: Record<string, { readonly name: string; readonly path: string }> = {
  'root-a': { name: 'alpha', path: '/ws/alpha' },
  'root-b': { name: 'bravo-root', path: '/ws/bravo-root' },
};
const FOLDER_BY_KEY: Record<string, string> = { alphaFile: 'root-a', bravoFile: 'root-b' };

const items = Object.keys(FOLDER_BY_KEY).map((key) => ({
  compositeKey: key,
  folderId: FOLDER_BY_KEY[key] ?? '',
  path: `${key}.txt`,
  tokens: 10,
  type: 'file' as const,
}));

const props = (
  overrides: Partial<ComponentProps<typeof PreviewPanel>> = {}
): ComponentProps<typeof PreviewPanel> => ({
  decodeFileSelection: (key) => ({ folderId: FOLDER_BY_KEY[key] ?? '', path: `${key}.txt` }),
  fileContents: { alphaFile: 'alpha content', bravoFile: 'bravo content' },
  loadingFiles: new Set<string>(),
  onSelectionChange: vi.fn(),
  performUndoableAction: vi.fn(),
  resolveRootDisplayName: (rootId) => FOLDERS[rootId]?.name,
  resolveRootPath: (rootId) => FOLDERS[rootId]?.path,
  selectedFiles: new Set(Object.keys(FOLDER_BY_KEY)),
  tokenCounting: {
    countTokens: vi.fn(async (content: string) => content.length),
    loading: false,
    mode: 'accurate',
    reason: null,
  },
  ...overrides,
});

beforeEach(() => {
  resetPreviewPanelPaginationMockState();
  localStorage.removeItem('previewPanelPreferences.v1');
  vi.clearAllMocks();
  useThreadFolderScopeStore.getState().reset();
  mockUsePreviewPanelState.mockReturnValue({
    flatListItems: items,
    loadingFiles: new Set<string>(),
    totalStats: { pendingCount: 0, totalFiles: items.length, totalTokens: 20 },
  });
});

describe('PreviewPanel thread notice', () => {
  it('asks once to add the folder, and drops the notice once the folder is in the thread', () => {
    const requestAdd = vi.fn(useThreadFolderScopeStore.getState().requestAdd);
    useThreadFolderScopeStore.setState({ requestAdd });
    useThreadFolderScopeStore
      .getState()
      .publishScope({ rootIds: ['root-a'], threadId: 'thread-1' });
    render(<PreviewPanel {...props()} />);

    expect(screen.queryByTestId('tapestry-thread-notice-root-a')).toBeNull();
    const notice = screen.getByTestId('tapestry-thread-notice-root-b');
    expect(notice).toHaveTextContent('from bravo-root, not in this thread');

    fireEvent.click(within(notice).getByRole('button', { name: 'Add to this thread' }));
    expect(requestAdd).toHaveBeenCalledTimes(1);
    expect(useThreadFolderScopeStore.getState().pendingAdd).toEqual({
      displayName: 'bravo-root',
      path: '/ws/bravo-root',
      rootId: 'root-b',
      threadId: 'thread-1',
    });

    act(() => {
      useThreadFolderScopeStore
        .getState()
        .publishScope({ rootIds: ['root-a', 'root-b'], threadId: 'thread-1' });
    });
    expect(screen.queryByTestId('tapestry-thread-notice-root-b')).toBeNull();
  });

  it('says a folder that is not in the workspace is unavailable, with nothing to add', () => {
    useThreadFolderScopeStore
      .getState()
      .publishScope({ rootIds: ['root-a'], threadId: 'thread-1' });
    render(
      <PreviewPanel
        {...props({
          resolveRootPath: (rootId) => (rootId === 'root-a' ? '/ws/alpha' : undefined),
        })}
      />
    );

    const notice = screen.getByTestId('tapestry-thread-notice-root-b');
    expect(notice).toHaveTextContent('from bravo-root, not a folder in the workspace');
    expect(within(notice).queryByRole('button')).toBeNull();
  });

  it('marks nothing while the thread has no binding', () => {
    render(<PreviewPanel {...props()} />);

    expect(screen.queryByTestId('tapestry-thread-notice-root-a')).toBeNull();
    expect(screen.queryByTestId('tapestry-thread-notice-root-b')).toBeNull();
  });
});
