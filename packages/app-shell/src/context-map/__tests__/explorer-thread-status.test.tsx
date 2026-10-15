import type { CommittedAssistantLogRow } from '@brainstrike/assistant-ui';
import { ThreadContextFold } from '@brainstrike/assistant-ui/thread-context-fold';
import {
  resetThreadContextStore,
  useThreadContextStore,
} from '@brainstrike/assistant-ui/thread-context-store';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  type ExplorerThreadStatusStore,
  useOptionalExplorerThreadStatus,
  WorkspaceTabsContext,
  type WorkspaceTabsValue,
} from '@brainstrike/file-explorer-ui/shell';
import { act, cleanup, render } from '@testing-library/react';
import { type ReactElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../../roots/root-identity-context';
import {
  explorerThreadFiles,
  fileFreshness,
  joinFolderPath,
} from '../explorer-thread-status-model';
import { ExplorerThreadStatusProvider } from '../explorer-thread-status-provider';

const active = vi.hoisted(() => ({ threadId: 'thread-1' as string | null }));
vi.mock('@brainstrike/assistant-data', () => ({
  useActiveAssistantThreadId: () => active.threadId,
}));
const explorer = vi.hoisted(() => ({
  rootDescriptors: {
    'adapter-1': { displayName: 'project', path: '/workspace/a' },
  } as Record<string, unknown>,
}));
vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()),
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof explorer) => T): T =>
    selector(explorer),
}));

const rootId = 'root-1';
const adapterRootId = 'adapter-1';
const A_KEY = encodeFileSelection(adapterRootId, '/workspace/a/src/deep/a.ts');
const A_CONTENT_KEY = encodeFileSelection(adapterRootId, 'src/deep/a.ts');

/** A thread that read lines 1-3 of src/deep/a.ts and a file of a folder not open here. */
function rows(): CommittedAssistantLogRow[] {
  const list: CommittedAssistantLogRow[] = [];
  const add = (event: Record<string, unknown>) =>
    list.push({ event, seq: list.length + 1, threadId: 'thread-1' });
  const read = (id: string, root: string, path: string) => {
    add({
      input: {},
      runId: 'r1',
      toolCallId: id,
      toolCatalogId: 'brainstrike.readWorkspaceFile',
      type: 'effect.started',
    });
    add({
      output: {
        approxOutputTokens: 1,
        content: ['1: one', '2: two', '3: three'].join('\n'),
        endLine: 3,
        path,
        rootId: root,
        startLine: 1,
        totalLines: 10,
        truncated: false,
      },
      runId: 'r1',
      toolCallId: id,
      type: 'effect.finished',
    });
  };
  add({ prompt: 'read', runId: 'r1', type: 'run.started' });
  read('a', rootId, 'src/deep/a.ts');
  read('z', 'root-elsewhere', 'z.ts');
  return list;
}

function record() {
  return { branchRunIds: ['r1'], snapshot: new ThreadContextFold().accept(rows()) };
}

const resolveFolder = (dbRootId: string) =>
  dbRootId === rootId ? { adapterRootId, path: '/workspace/a' } : null;

describe('explorerThreadFiles', () => {
  it('addresses each touched file by its explorer row, and counts it in every folder above it', () => {
    const touched = explorerThreadFiles(record(), resolveFolder);
    expect(touched.files.map((file) => [file.key, file.contentKey, file.kinds])).toEqual([
      [A_KEY, A_CONTENT_KEY, ['read']],
    ]);
    expect(touched.unmapped).toBe(1);
    expect([...touched.directories]).toEqual([
      [encodeFileSelection(adapterRootId, '/workspace/a'), 1],
      [encodeFileSelection(adapterRootId, '/workspace/a/src'), 1],
      [encodeFileSelection(adapterRootId, '/workspace/a/src/deep'), 1],
    ]);
    expect(touched.touchedPaths).toEqual(['/workspace/a/src/deep/a.ts']);
  });

  it('joins a folder-relative path in the separator its folder uses', () => {
    expect(joinFolderPath('/w/a/', 'src/x.ts')).toBe('/w/a/src/x.ts');
    expect(joinFolderPath('C:\\w\\a', 'src/x.ts')).toBe('C:\\w\\a\\src\\x.ts');
  });
});

describe('fileFreshness', () => {
  const [file] = explorerThreadFiles(record(), resolveFolder).files;
  if (!file) {
    throw new Error('expected a touched file');
  }

  it('compares the delivered lines with the current text', () => {
    const ready = { failed: false, loading: false };
    expect(fileFreshness(file, 'one\ntwo\nthree\nfour', ready)).toBe('unchanged');
    expect(fileFreshness(file, 'one\nTWO\nthree', ready)).toBe('changed');
  });

  it('is checking while the text loads, and unknown when it cannot be read', () => {
    expect(fileFreshness(file, undefined, { failed: false, loading: true })).toBe('checking');
    expect(fileFreshness(file, undefined, { failed: true, loading: false })).toBe('unknown');
  });
});

describe('ExplorerThreadStatusProvider', () => {
  const onRetryFileContent = vi.fn();
  let published: ExplorerThreadStatusStore | null = null;

  function Probe({ watch }: { readonly watch: boolean }): null {
    const store = useOptionalExplorerThreadStatus();
    published = store;
    useEffect(() => (watch && store ? store.watch(A_KEY) : undefined), [store, watch]);
    return null;
  }

  function Tree({
    fileContents = {},
    watch,
  }: {
    readonly fileContents?: Record<string, string>;
    readonly watch: boolean;
  }): ReactElement {
    const tabs = {
      fileContentErrors: new Map(),
      fileContents,
      loadingFiles: new Set<string>(),
      onRetryFileContent,
    } as unknown as WorkspaceTabsValue;
    return (
      <WorkspaceTabsContext.Provider value={tabs}>
        <RootIdentityProvider dbRootIdByAdapterRootId={new Map([[adapterRootId, rootId]])}>
          <ExplorerThreadStatusProvider>
            <Probe watch={watch} />
          </ExplorerThreadStatusProvider>
        </RootIdentityProvider>
      </WorkspaceTabsContext.Provider>
    );
  }

  beforeEach(() => {
    onRetryFileContent.mockClear();
    active.threadId = 'thread-1';
    resetThreadContextStore();
    useThreadContextStore.getState().record('thread-1', record());
  });
  afterEach(cleanup);

  it("publishes the active thread's files, and reads a file only once its row shows", () => {
    const { rerender } = render(<Tree watch={false} />);
    expect(published?.getFileStatus(A_KEY)).toMatchObject({
      freshness: 'unknown',
      kinds: ['read'],
    });
    expect(published?.getTouchedPaths()).toEqual(['/workspace/a/src/deep/a.ts']);
    expect(onRetryFileContent).not.toHaveBeenCalled();

    rerender(<Tree watch />);
    expect(onRetryFileContent).toHaveBeenCalledExactlyOnceWith(A_CONTENT_KEY);
    expect(published?.getFileStatus(A_KEY)?.freshness).toBe('checking');

    rerender(<Tree fileContents={{ [A_CONTENT_KEY]: 'one\ntwo\nthree' }} watch />);
    expect(published?.getFileStatus(A_KEY)?.freshness).toBe('unchanged');
    rerender(<Tree fileContents={{ [A_CONTENT_KEY]: 'one\nTWO\nthree' }} watch />);
    expect(published?.getFileStatus(A_KEY)?.freshness).toBe('changed');
    expect(onRetryFileContent).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing without an active thread', () => {
    active.threadId = null;
    render(<Tree watch={false} />);
    act(() => undefined);
    expect(published?.getTouchedPaths()).toEqual([]);
  });
});
