import {
  EMPTY_WORKSPACE_SNAPSHOT,
  type ThreadWorkspaceRepository,
} from '@brainstrike/assistant-data';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui/shell';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../../assistant-thread-host-context';
import { ThreadWorkspaceCoordinator } from '../thread-workspace-coordinator';

const captured = vi.hoisted(() => ({ repository: null as ThreadWorkspaceRepository | null }));
vi.mock('../use-thread-workspace-coordinator', () => ({
  useThreadWorkspaceCoordinator: (options: { repository: ThreadWorkspaceRepository | null }) => {
    captured.repository = options.repository;
  },
}));
vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: (options?: { enabled?: boolean }) => {
    if (options?.enabled !== false) {
      throw new Error('A host workspace must not open PGlite');
    }
    return null;
  },
}));
afterEach(() => {
  cleanup();
  captured.repository = null;
});
test('mounts the actual host snapshot repository without a database provider', async () => {
  const repository: ThreadWorkspaceRepository = {
    getThreadWorkspace: vi.fn(async () => EMPTY_WORKSPACE_SNAPSHOT),
    getThreadWorkspaces: vi.fn(async () => new Map()),
    setThreadWorkspace: vi.fn(async () => undefined),
  };
  const host: AssistantThreadHostCapability = {
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    listThreads: vi.fn(),
    ownsThread: vi.fn(),
    renameThread: vi.fn(),
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => repository,
  };
  render(
    <AssistantThreadHostContext.Provider value={host}>
      <FileExplorerProvider storageAdapter={new MemoryStorageAdapter()}>
        <ThreadWorkspaceCoordinator />
      </FileExplorerProvider>
    </AssistantThreadHostContext.Provider>
  );
  expect(captured.repository).toBe(repository);
  await captured.repository?.setThreadWorkspace('thread', 'workspace', EMPTY_WORKSPACE_SNAPSHOT);
  expect(repository.setThreadWorkspace).toHaveBeenCalledExactlyOnceWith(
    'thread',
    'workspace',
    EMPTY_WORKSPACE_SNAPSHOT
  );
});
