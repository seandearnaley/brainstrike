// @vitest-environment jsdom
import type { FileSearchBatch, HostClient } from '@brainstrike/agent-host';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopHostConnection } from '../../renderer/desktop-host-connection';
import { createDesktopFileSearch } from '../../renderer/host-file-search';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

const SUMMARY = {
  candidatesTruncated: false,
  matches: 1,
  matchLimitReached: false,
  scanLimited: false,
  timedOut: false,
  unreadableRootIds: [],
};
const MATCH = { line: 2, lineText: 'const needle = 1;', path: 'a.ts', rootId: 'root-1' };
const REQUEST = { caseSensitive: false, isRegex: false, query: 'needle', wholeWord: false };

/** A host client whose search answers when the test says, streaming batches meanwhile. */
function fakeHost() {
  const listeners = new Set<(batch: FileSearchBatch) => void>();
  let answer: (() => void) | undefined;
  let searchId = '';
  let signal: AbortSignal | undefined;
  const client = {
    onFileSearch: (listener: (batch: FileSearchBatch) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: vi.fn(
      (_method: string, params: { searchId: string }, requestSignal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          searchId = params.searchId;
          signal = requestSignal;
          requestSignal?.addEventListener('abort', () => reject(requestSignal.reason));
          answer = () => resolve(SUMMARY);
        })
    ),
  };
  const connection = {
    current: async () => client as unknown as HostClient,
  } as unknown as DesktopHostConnection;
  const emit = (batch: FileSearchBatch) => {
    for (const listener of listeners) {
      listener(batch);
    }
  };
  return {
    answer: () => answer?.(),
    connection,
    emit,
    listeners,
    searchId: () => searchId,
    signal: () => signal,
  };
}

/** Lets the search reach the host. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** ADR-0035: the Search tab's matches stream from the agent host's live search. */
describe('desktop file search', () => {
  it('hands on this search’s batches only, and answers with what the search hit', async () => {
    const host = fakeHost();
    const onMatches = vi.fn();
    const pending = createDesktopFileSearch(host.connection).search(
      REQUEST,
      onMatches,
      new AbortController().signal
    );
    await settle();
    host.emit({ matches: [MATCH], searchId: host.searchId() });
    host.emit({ matches: [{ ...MATCH, path: 'other.ts' }], searchId: 'another-search' });
    host.answer();

    await expect(pending).resolves.toEqual({
      candidatesTruncated: false,
      matchLimitReached: false,
      scanLimited: false,
      timedOut: false,
      unreadableRootIds: [],
    });
    expect(onMatches).toHaveBeenCalledExactlyOnceWith([MATCH]);
    expect(host.listeners.size).toBe(0);
  });

  it('a cancelled search cancels its request and hands on no later batch', async () => {
    const host = fakeHost();
    const onMatches = vi.fn();
    const controller = new AbortController();
    const pending = createDesktopFileSearch(host.connection).search(
      REQUEST,
      onMatches,
      controller.signal
    );
    await settle();
    controller.abort(new Error('a newer query'));
    host.emit({ matches: [MATCH], searchId: host.searchId() });

    await expect(pending).rejects.toThrow('a newer query');
    expect(host.signal()?.aborted).toBe(true);
    expect(onMatches).not.toHaveBeenCalled();
    expect(host.listeners.size).toBe(0);
  });
});
