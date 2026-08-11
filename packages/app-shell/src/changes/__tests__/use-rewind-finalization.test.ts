/**
 * The trigger that ends a rewind's redo window (BST-1115, W5 T4b).
 *
 * The behaviour under test is a CONJUNCTION — a user-authored composer submit
 * AND a run actually being created — so each half is exercised alone to prove
 * it does not finalize on its own. Every case here was control-tested against
 * a version that fires on either half alone.
 */
import type { AssistantRewindFinalization } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { GitResult } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useRewindFinalization } from '../use-rewind-finalization';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/ui', () => ({ toast: toastMock }));

const THREAD_ID = 'thread-1';
const PREPARED = { memory: { runId: 'run-1' } } as const;

function finalization(
  overrides: Partial<AssistantRewindFinalization> = {}
): AssistantRewindFinalization {
  return {
    deletedMessageIds: ['msg-2', 'msg-3'],
    finalized: true,
    rewindIds: ['rewind-1'],
    ...overrides,
  };
}

/**
 * Fills in every method this suite never calls — `resolveChangesBridge`
 * requires a FULLY formed bridge, and a partial one reads as malformed.
 */
function installBridge(
  finalizeRewinds: ChangesBridge['finalizeRewinds']
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(finalizeRewinds);
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: spy as unknown as ChangesBridge['finalizeRewinds'],
    inventory: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
  } as unknown as ChangesBridge;
  return spy;
}

const OK: GitResult<AssistantRewindFinalization> = { ok: true, value: finalization() };

/** `noThread` is a FLAG rather than `threadId: undefined`, which a default
 * parameter would silently turn back into the real thread id. */
function render(
  options: {
    readonly noThread?: boolean;
    readonly prepareRequestData?: (abortSignal?: AbortSignal) => Promise<Record<string, unknown>>;
  } = {}
) {
  const prepareRequestData = options.prepareRequestData ?? (async () => PREPARED);
  const threadId = options.noThread === true ? undefined : THREAD_ID;
  return renderHook(() => useRewindFinalization({ prepareRequestData, threadId }));
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  toastMock.mockReset();
  vi.restoreAllMocks();
});

describe('useRewindFinalization', () => {
  it('finalizes when a user-authored submit is followed by a run creation', async () => {
    const finalizeRewinds = installBridge(async () => OK);
    const { result } = render();

    await act(async () => {
      result.current.markUserAuthoredSend();
      await result.current.prepareRequestData();
    });

    await waitFor(() => expect(finalizeRewinds).toHaveBeenCalledWith({ threadId: THREAD_ID }));
  });

  it('returns what the wrapped seam returned, unchanged', async () => {
    installBridge(async () => OK);
    const { result } = render();

    const prepared = await act(async () => result.current.prepareRequestData());

    expect(prepared).toEqual(PREPARED);
  });

  // A tool-approval resume, a stream replay and a plan-mode continuation all
  // create runs WITHOUT a composer submit. None of them is a new user message,
  // so none of them may close the redo window.
  it('does NOT finalize for a run created without a user-authored submit', async () => {
    const finalizeRewinds = installBridge(async () => OK);
    const { result } = render();

    await act(async () => {
      await result.current.prepareRequestData();
    });

    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  // assistant-ui calls `form.requestSubmit()` on Enter unconditionally, so an
  // Enter on an EMPTY composer fires the submit and sends nothing. Finalizing
  // there would hard-delete a redoable rewind on a keystroke that did nothing.
  it('does NOT finalize for a submit that never produces a run', async () => {
    const finalizeRewinds = installBridge(async () => OK);
    const { result } = render();

    act(() => {
      result.current.markUserAuthoredSend();
    });

    await Promise.resolve();
    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  it('licenses exactly ONE finalization per submit', async () => {
    const finalizeRewinds = installBridge(async () => OK);
    const { result } = render();

    await act(async () => {
      result.current.markUserAuthoredSend();
      await result.current.prepareRequestData();
      // A resume inside the same turn: the flag was already consumed.
      await result.current.prepareRequestData();
    });

    await waitFor(() => expect(finalizeRewinds).toHaveBeenCalledTimes(1));
  });

  // The abort is thrown by `prepareRequest` AFTER this resolves, so no message
  // was authored. The arming flag survives for the retry that actually sends.
  it('does NOT finalize when the preparation was aborted, and stays armed', async () => {
    const finalizeRewinds = installBridge(async () => OK);
    const controller = new AbortController();
    const { result } = render({
      prepareRequestData: async () => {
        controller.abort();
        return PREPARED;
      },
    });

    await act(async () => {
      result.current.markUserAuthoredSend();
      await result.current.prepareRequestData(controller.signal);
    });
    expect(finalizeRewinds).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.prepareRequestData();
    });
    await waitFor(() => expect(finalizeRewinds).toHaveBeenCalledTimes(1));
  });

  it('does not call the bridge without a thread', async () => {
    const finalizeRewinds = installBridge(async () => OK);
    const { result } = render({ noThread: true });

    await act(async () => {
      result.current.markUserAuthoredSend();
      await result.current.prepareRequestData();
    });

    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  // Web has no rewind at all, so an absent bridge means there is nothing to
  // finalize — capability gating, and it must not throw into the send path.
  it('is inert with the bridge absent, and still prepares the request', async () => {
    const { result } = render();

    const prepared = await act(async () => {
      result.current.markUserAuthoredSend();
      return await result.current.prepareRequestData();
    });

    expect(prepared).toEqual(PREPARED);
  });
});

/**
 * THE SEND IS NEVER BLOCKED. The finalization is fired for effect and never
 * awaited, so neither a hung bridge, a typed refusal, nor a thrown bridge can
 * reach the composer. The failure is still VISIBLE: logged and toasted.
 */
describe('useRewindFinalization — failure never blocks the send', () => {
  const logger = createLogger('RewindFinalization');

  it('resolves the prepared request even when the bridge never settles', async () => {
    installBridge(() => new Promise<never>(() => undefined));
    const { result } = render();

    const prepared = await act(async () => {
      result.current.markUserAuthoredSend();
      return await result.current.prepareRequestData();
    });

    expect(prepared).toEqual(PREPARED);
  });

  it('surfaces a typed transport failure without rejecting the preparation', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    installBridge(async () => ({ error: 'ipc exploded', ok: false }));
    const { result } = render();

    const prepared = await act(async () => {
      result.current.markUserAuthoredSend();
      return await result.current.prepareRequestData();
    });

    expect(prepared).toEqual(PREPARED);
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({
      title: 'Could not finalize the rewind',
      variant: 'destructive',
    });
    expect(toastMock.mock.calls[0]?.[0]?.description).toContain('ipc exploded');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('surfaces a THROWN bridge without rejecting the preparation', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    installBridge(async () => {
      throw new Error('preload detached');
    });
    const { result } = render();

    const prepared = await act(async () => {
      result.current.markUserAuthoredSend();
      return await result.current.prepareRequestData();
    });

    expect(prepared).toEqual(PREPARED);
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0]?.[0]?.description).toContain('preload detached');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('says nothing for the ordinary "no outstanding rewind" answer', async () => {
    const finalizeRewinds = installBridge(async () => ({
      ok: true,
      value: finalization({ deletedMessageIds: [], finalized: false, rewindIds: [] }),
    }));
    const { result } = render();

    await act(async () => {
      result.current.markUserAuthoredSend();
      await result.current.prepareRequestData();
    });

    await waitFor(() => expect(finalizeRewinds).toHaveBeenCalledTimes(1));
    expect(toastMock).not.toHaveBeenCalled();
  });
});
