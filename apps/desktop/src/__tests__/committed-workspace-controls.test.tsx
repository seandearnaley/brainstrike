// @vitest-environment jsdom

import type { WorkspaceBarHost } from '@brainstrike/app-shell';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
} from '@brainstrike/file-explorer-ui/shell';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { CommittedWorkspaceControls } from '../renderer/committed-workspace-controls';

type HostProps = ComponentProps<typeof WorkspaceBarHost>;

const { hosted, history } = vi.hoisted(() => ({
  history: { updateThreadMetadata: vi.fn(async () => undefined) },
  hosted: { props: undefined as HostProps | undefined },
}));
vi.mock('@brainstrike/app-shell', () => ({
  WorkspaceBarHost: (props: HostProps): ReactElement => {
    hosted.props = props;
    return <div data-testid="workspace-bar" />;
  },
}));
const DATABASE = { kind: 'database' } as const;
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => DATABASE }));
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  createPgliteAssistantThreadRepository: () => history,
}));

const HOST_THREAD = 'host-thread-0001';
const REPO = { displayName: 'repo', path: '/ws/repo', rootId: 'root-repo' };
const OTHER = { displayName: 'other', path: '/ws/other', rootId: 'root-other' };

function hostCapability(): AssistantThreadHostCapability {
  return {
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    listThreads: vi.fn(),
    ownsThread: vi.fn(async (threadId: string) => threadId === HOST_THREAD),
    renameThread: vi.fn(),
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(async () => undefined),
    workspaceRepository: (repository) => repository,
  };
}

let explorer: ReturnType<typeof useFileExplorerStoreContext> | undefined;
function CaptureExplorer(): null {
  explorer = useFileExplorerStoreContext();
  return null;
}

function mount(
  host: AssistantThreadHostCapability
): ReturnType<typeof useFileExplorerStoreContext> {
  render(
    <AssistantThreadHostContext.Provider value={host}>
      <FileExplorerProvider storageAdapter={new MemoryStorageAdapter()}>
        <CaptureExplorer />
        <CommittedWorkspaceControls threadId={HOST_THREAD} />
      </FileExplorerProvider>
    </AssistantThreadHostContext.Provider>
  );
  if (!explorer) {
    throw new Error('The explorer store did not mount');
  }
  return explorer;
}

function hostedRepository(): AssistantThreadRepository {
  const repository = hosted.props?.assistantThreadRepository;
  if (!repository) {
    throw new Error('The bar received no thread repository');
  }
  return repository;
}

afterEach(() => {
  cleanup();
  hosted.props = undefined;
  explorer = undefined;
  vi.clearAllMocks();
});

test('binds the bar to the committed host thread through the host-routed repository', async () => {
  const host = hostCapability();
  mount(host);
  expect(hosted.props).toMatchObject({
    database: DATABASE,
    memoryResourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    selectedMemoryThreadId: HOST_THREAD,
  });
  // Main validates scope-changing bindings before Core commits them, so the
  // folder and worktree actions are live on the committed path.
  expect(hosted.props).not.toHaveProperty('threadFoldersUnavailableReason');
  // A folder/checkout write for this host thread commits through the host's
  // binding owner and never reaches the history repository (no row there).
  const patch = { secondaryRootIds: ['root-other'] };
  await hostedRepository().updateThreadMetadata(HOST_THREAD, patch);
  expect(host.updateThreadBinding).toHaveBeenCalledExactlyOnceWith(HOST_THREAD, patch);
  expect(history.updateThreadMetadata).not.toHaveBeenCalled();
});

test('names the MAIN folder for an unbound thread; explorer focus never names it', () => {
  const store = mount(hostCapability());
  expect(hosted.props && 'currentMainRoot' in hosted.props).toBe(false);
  act(() => {
    store.getState().setActiveRoots([REPO, OTHER]);
    store.getState().setCurrentFolderId(OTHER.rootId);
  });
  expect(hosted.props?.currentMainRoot).toEqual(REPO);
  expect(hosted.props?.rootDescriptors).toEqual({
    [OTHER.rootId]: OTHER,
    [REPO.rootId]: REPO,
  });
  act(() => {
    store.getState().setCurrentFolderId(REPO.rootId);
    store.getState().setMainRoot(OTHER.rootId);
  });
  expect(hosted.props?.currentMainRoot).toEqual(OTHER);
});
