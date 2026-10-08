// @vitest-environment jsdom

import type { WorkspaceBarHostProps } from '@brainstrike/app-shell';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
} from '@brainstrike/file-explorer-ui/shell';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  CommittedWorkspaceControls,
  HOST_THREAD_FOLDERS_UNAVAILABLE_REASON,
} from '../renderer/committed-workspace-controls';

const { hosted } = vi.hoisted(() => ({
  hosted: { props: undefined as WorkspaceBarHostProps | undefined },
}));
vi.mock('@brainstrike/app-shell', () => ({
  WorkspaceBarHost: (props: WorkspaceBarHostProps): ReactElement => {
    hosted.props = props;
    return <div data-testid="workspace-bar" />;
  },
}));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => null }));

const HOST_THREAD = 'host-thread-0001';
const REPO = { displayName: 'repo', path: '/ws/repo', rootId: 'root-repo' };
const OTHER = { displayName: 'other', path: '/ws/other', rootId: 'root-other' };

let explorer: ReturnType<typeof useFileExplorerStoreContext> | undefined;
function CaptureExplorer(): null {
  explorer = useFileExplorerStoreContext();
  return null;
}

function mount(): ReturnType<typeof useFileExplorerStoreContext> {
  render(
    <FileExplorerProvider storageAdapter={new MemoryStorageAdapter()}>
      <CaptureExplorer />
      <CommittedWorkspaceControls threadId={HOST_THREAD} />
    </FileExplorerProvider>
  );
  if (!explorer) {
    throw new Error('The explorer store did not mount');
  }
  return explorer;
}

afterEach(() => {
  cleanup();
  hosted.props = undefined;
  explorer = undefined;
});

test('binds the bar to the committed host thread with no thread metadata writer', () => {
  mount();
  expect(hosted.props).toMatchObject({
    assistantThreadRepository: null,
    memoryResourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    selectedMemoryThreadId: HOST_THREAD,
    threadFoldersUnavailableReason: HOST_THREAD_FOLDERS_UNAVAILABLE_REASON,
  });
});

test('names the focused folder, the root a committed run binds at Send', () => {
  const store = mount();
  expect(hosted.props?.currentMainRoot).toBeUndefined();
  act(() => {
    store.getState().setActiveRoots([REPO, OTHER]);
    store.getState().setCurrentFolderId(OTHER.rootId);
  });
  expect(hosted.props?.currentMainRoot).toEqual(OTHER);
  expect(hosted.props?.rootDescriptors).toEqual({
    [OTHER.rootId]: OTHER,
    [REPO.rootId]: REPO,
  });
  act(() => {
    store.getState().setCurrentFolderId(REPO.rootId);
  });
  expect(hosted.props?.currentMainRoot).toEqual(REPO);
  // No focused folder: no primary is invented from the mounted roots.
  act(() => {
    store.getState().setCurrentFolderId(null);
  });
  expect(hosted.props && 'currentMainRoot' in hosted.props).toBe(false);
});
