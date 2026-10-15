import type { PromptToolCall } from '@brainstrike/assistant-contract/context-breakdown';
import { diffPromptToolCallWindow } from '@brainstrike/assistant-contract/context-breakdown';
import type { CommittedAssistantLogRow } from '@brainstrike/assistant-ui';
import { ThreadContextFold } from '@brainstrike/assistant-ui/thread-context-fold';
import {
  resetThreadContextStore,
  useThreadContextStore,
} from '@brainstrike/assistant-ui/thread-context-store';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  createFileExplorerRefreshEvent,
  WorkspaceTabsContext,
  type WorkspaceTabsValue,
} from '@brainstrike/file-explorer-ui/shell';
import type { IndexChunkBoundsCapability } from '@brainstrike/indexing-contract/indexer-client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../../roots/root-identity-context';
import { contextBundleMarkdown } from '../context-bundle';
import { contextFileRows } from '../context-map-model';
import { ThreadContextPage } from '../thread-context-page';

const active = vi.hoisted(() => ({ threadId: 'thread-1' as string | null }));
vi.mock('@brainstrike/assistant-data', () => ({
  useActiveAssistantThreadId: () => active.threadId,
}));
const explorer = vi.hoisted(() => ({
  rootDescriptors: { 'adapter-1': { displayName: 'project' } } as Record<string, unknown>,
}));
vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()),
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof explorer) => T): T =>
    selector(explorer),
}));

const rootId = 'root-1';

function rows(): CommittedAssistantLogRow[] {
  const list: CommittedAssistantLogRow[] = [];
  const add = (event: Record<string, unknown>) =>
    list.push({ event, seq: list.length + 1, threadId: 'thread-1' });
  const read = (runId: string, id: string, path: string, start: number, end: number) => {
    add({
      input: {},
      runId,
      toolCallId: id,
      toolCatalogId: 'brainstrike.readWorkspaceFile',
      type: 'effect.started',
    });
    add({
      output: {
        approxOutputTokens: 1,
        content: Array.from({ length: end - start + 1 }, (_, i) => `${start + i}: x`).join('\n'),
        endLine: end,
        path,
        rootId,
        startLine: start,
        totalLines: 100,
        truncated: false,
      },
      runId,
      toolCallId: id,
      type: 'effect.finished',
    });
  };
  const sent = (id: string, outputTokens: number): PromptToolCall => ({
    inputTokens: 0,
    output: 'full',
    outputTokens,
    toolCallId: id,
    toolName: 'brainstrike.readWorkspaceFile',
  });
  add({ prompt: 'first', runId: 'r1', type: 'run.started' });
  read('r1', 'a', 'src/a.ts', 1, 40);
  add({
    runId: 'r1',
    toolCallWindow: diffPromptToolCallWindow(undefined, [sent('a', 400)]),
    type: 'provider.request.prepared',
  });
  add({ prompt: 'second', runId: 'r2', type: 'run.started' });
  add({
    compactedRunIds: ['r1'],
    kind: 'deterministic',
    reason: 'pre-request',
    runId: 'r2',
    summary: 's',
    type: 'context.compacted',
  });
  read('r2', 'b', 'src/b.ts', 1, 20);
  add({
    runId: 'r2',
    toolCallWindow: diffPromptToolCallWindow(undefined, [sent('b', 200)]),
    type: 'provider.request.prepared',
  });
  return list;
}

function seed(): void {
  const snapshot = new ThreadContextFold().accept(rows());
  useThreadContextStore.getState().record('thread-1', { branchRunIds: ['r1', 'r2'], snapshot });
}

const chunkBounds: IndexChunkBoundsCapability = {
  fileChunks: vi.fn<IndexChunkBoundsCapability['fileChunks']>(async ({ paths, rootId: root }) => ({
    files: paths.map((path) => ({
      chunks: [
        { chunkId: `${path}-1`, contentHash: 'h', endLine: 20, startLine: 1, tokenCount: 10 },
        { chunkId: `${path}-2`, contentHash: 'h', endLine: 40, startLine: 21, tokenCount: 10 },
      ],
      contentHash: 'h',
      kind: 'indexed' as const,
      path,
    })),
    rootId: root,
    storeId: 's',
  })),
};

const adapterRootId = 'adapter-1';
const onRetryFileContent = vi.fn();

function Page({
  chunkBounds: bounds,
  fileContents = {},
}: {
  readonly chunkBounds: IndexChunkBoundsCapability | null;
  readonly fileContents?: Record<string, string>;
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
        <ThreadContextPage chunkBounds={bounds} />
      </RootIdentityProvider>
    </WorkspaceTabsContext.Provider>
  );
}

beforeEach(() => {
  onRetryFileContent.mockClear();
  active.threadId = 'thread-1';
  resetThreadContextStore();
  vi.mocked(chunkBounds.fileChunks).mockClear();
});
afterEach(cleanup);

describe('ThreadContextPage', () => {
  it('asks for an active thread, then for a first run', () => {
    active.threadId = null;
    const { rerender } = render(<Page chunkBounds={null} />);
    expect(screen.getByText('No active thread')).toBeTruthy();
    active.threadId = 'thread-1';
    rerender(<Page chunkBounds={null} />);
    expect(screen.getByText('Nothing delivered yet')).toBeTruthy();
  });

  it("shows the latest turn's window, with compacted files still listed and drawn by index chunks", async () => {
    seed();
    render(<Page chunkBounds={chunkBounds} />);
    expect(screen.getByTestId('context-map-window-tokens').textContent).toBe('~200 tokens');
    const files = screen.getAllByTestId('context-map-file');
    expect(files.map((file) => within(file).getAllByText(/\.ts$/u)[0]?.textContent)).toEqual([
      'b.ts',
      'a.ts',
    ]);
    await waitFor(() =>
      expect(chunkBounds.fileChunks).toHaveBeenCalledWith({
        paths: ['src/a.ts', 'src/b.ts'],
        rootId,
      })
    );
    await waitFor(() => expect(files[1]?.querySelector('[data-state="gone"]')).toBeTruthy());
    expect(screen.getAllByTestId('context-map-compaction-marker')).toHaveLength(1);
  });

  it("shows the composer ring's figure with the files' share and the compaction tick", () => {
    seed();
    useThreadContextStore
      .getState()
      .recordRing('thread-1', { budgetTokens: 10_000, isEstimated: false, usedTokens: 4500 });
    render(<Page chunkBounds={null} />);
    expect(screen.getByTestId('context-map-ring-total').textContent).toBe('4.5K / 10.0K tokens');
    expect(
      screen.getByRole('meter', { name: 'Context in use' }).getAttribute('aria-valuenow')
    ).toBe('4500');
  });

  it('scrubs to an earlier turn, where the compacted read was still in the window', () => {
    seed();
    render(<Page chunkBounds={null} />);
    act(() => {
      fireEvent.click(screen.getByTestId('context-map-turn-1'));
    });
    expect(screen.getByText(/As of turn 1 of 2/u)).toBeTruthy();
    expect(screen.getByTestId('context-map-window-tokens').textContent).toBe('~400 tokens');
    expect(screen.getAllByTestId('context-map-file')).toHaveLength(1);
  });

  it('reads chunk bounds once per file until the thread starts another turn', async () => {
    seed();
    render(<Page chunkBounds={chunkBounds} />);
    await waitFor(() => expect(chunkBounds.fileChunks).toHaveBeenCalledTimes(1));
    act(() => {
      fireEvent.click(screen.getByTestId('context-map-turn-1'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('context-map-turn-2'));
    });
    expect(chunkBounds.fileChunks).toHaveBeenCalledTimes(1);
    act(() => {
      const next = [...rows()];
      next.push({
        event: { prompt: 'third', runId: 'r3', type: 'run.started' },
        seq: next.length + 1,
        threadId: 'thread-1',
      });
      const snapshot = new ThreadContextFold().accept(next);
      useThreadContextStore
        .getState()
        .record('thread-1', { branchRunIds: ['r1', 'r2', 'r3'], snapshot });
    });
    await waitFor(() => expect(chunkBounds.fileChunks).toHaveBeenCalledTimes(2));
  });

  it('flags a shown file whose delivered lines no longer match the current file', () => {
    seed();
    const key = encodeFileSelection(adapterRootId, 'src/b.ts');
    const lines = Array.from({ length: 20 }, () => 'x');
    const { rerender } = render(
      <Page chunkBounds={null} fileContents={{ [key]: lines.join('\n') }} />
    );
    expect(onRetryFileContent).toHaveBeenCalledWith(key);
    // The lens names the folder the explorer shows, not the root's id.
    expect(screen.getByTestId('context-map-lens').textContent).toContain('project · in window');
    expect(screen.getByTestId('context-map-lens-freshness').textContent).toBe(
      'Compared with the current file'
    );
    expect(screen.queryByTestId('context-map-changed-since-read')).toBeNull();
    lines[2] = 'y';
    rerender(<Page chunkBounds={null} fileContents={{ [key]: lines.join('\n') }} />);
    expect(screen.getByTestId('context-map-changed-since-read').textContent).toBe(
      'Changed since read: src/b.ts'
    );
    const lens = screen.getByTestId('context-map-lens');
    expect(lens.querySelector('[data-freshness="changed"]')).toBeTruthy();
  });

  it('reads the file again when the watcher reports a change that reaches it', () => {
    seed();
    const key = encodeFileSelection(adapterRootId, 'src/b.ts');
    render(<Page chunkBounds={null} />);
    expect(onRetryFileContent).toHaveBeenCalledTimes(1);
    const change = (path: string) =>
      createFileExplorerRefreshEvent({
        roots: [
          {
            changes: [{ kind: 'file', path, type: 'modified' }],
            rootId: adapterRootId,
            rootPath: '/workspace/a',
          },
        ],
        scope: 'incremental',
        source: 'watcher',
      });
    act(() => {
      window.dispatchEvent(change('/workspace/a/src/other.ts'));
    });
    expect(onRetryFileContent).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(change('/workspace/a/src/b.ts'));
    });
    expect(onRetryFileContent).toHaveBeenCalledTimes(2);
    expect(onRetryFileContent).toHaveBeenLastCalledWith(key);
  });

  it('leaves freshness unknown when the explorer has no text for the file', () => {
    seed();
    render(<Page chunkBounds={null} />);
    expect(screen.getByTestId('context-map-lens-freshness').textContent).toBe(
      'Reading the current file…'
    );
    expect(
      screen.getByTestId('context-map-lens').querySelector('[data-freshness="unchanged"]')
    ).toBeNull();
  });

  it('orders by everything delivered when switched to "Everything seen"', () => {
    seed();
    render(<Page chunkBounds={null} />);
    act(() => {
      fireEvent.mouseDown(screen.getByTestId('context-map-mode-all'));
      fireEvent.click(screen.getByTestId('context-map-mode-all'));
    });
    const first = screen.getAllByTestId('context-map-file')[0];
    expect(first && within(first).getAllByText(/\.ts$/u)[0]?.textContent).toBe('a.ts');
  });
});

describe('contextBundleMarkdown', () => {
  it('writes the in-window spans with their delivered text, fenced', () => {
    const snapshot = new ThreadContextFold().accept(rows());
    const calls = [...snapshot.calls.values()].map((call, index) => ({
      call,
      deliveredTokens: 1,
      state: index === 0 ? ('compacted' as const) : ('in-window' as const),
      turn: index + 1,
      windowTokens: 1,
    }));
    const markdown = contextBundleMarkdown(contextFileRows(calls, 'window'), 2);
    expect(markdown).toContain('## src/b.ts');
    expect(markdown).not.toContain('src/a.ts');
    expect(markdown).toContain('Read, lines 1–20 (turn 2)');
    expect(markdown).toContain('```\nx\nx');
  });
});
