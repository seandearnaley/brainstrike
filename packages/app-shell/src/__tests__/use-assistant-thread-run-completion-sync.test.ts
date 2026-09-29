import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();
const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.map(String).join(':'),
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ warn: loggerWarnMock }),
}));

import { useAssistantThreadRunCompletionSync } from '../use-assistant-thread-run-completion-sync';

const repository = {} as AssistantThreadRepository;

/** What the aggregate query delivers: always exactly one row, even with no runs. */
function delivery(terminalCount: number, lastCompletedAt: string | null): unknown {
  return { error: null, loading: false, rows: [{ lastCompletedAt, terminalCount }] };
}

function renderSync(
  refreshResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>,
  overrides: {
    enabled?: boolean;
    repository?: AssistantThreadRepository | null;
    resourceId?: string;
  } = {}
) {
  return renderHook(
    (props: { enabled: boolean; resourceId: string }) =>
      useAssistantThreadRunCompletionSync({
        enabled: props.enabled,
        refreshResourceThreads,
        repository: overrides.repository === undefined ? repository : overrides.repository,
        resourceId: props.resourceId,
      }),
    {
      initialProps: {
        enabled: overrides.enabled ?? true,
        resourceId: overrides.resourceId ?? 'r1',
      },
    }
  );
}

describe('useAssistantThreadRunCompletionSync', () => {
  afterEach(() => {
    usePGliteLiveQueryMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('does not refresh on the initial delivery', () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(2, '2026-09-28 10:00:00+00'));

    renderSync(refreshResourceThreads);

    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('refreshes the thread list when a terminal write lands, with no title change', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const { rerender } = renderSync(refreshResourceThreads);

    usePGliteLiveQueryMock.mockReturnValue(delivery(2, '2026-09-28 10:05:00+00'));
    rerender({ enabled: true, resourceId: 'r1' });

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledTimes(1);
    });
    expect(refreshResourceThreads).toHaveBeenCalledWith(repository, 'r1');
  });

  it('refreshes when a resumed run reaches its terminal state again at the same count', async () => {
    // A run that pauses and resumes leaves and re-enters a terminal status, so the
    // count returns to its old value; the completion time is what moved.
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const { rerender } = renderSync(refreshResourceThreads);

    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:07:00+00'));
    rerender({ enabled: true, resourceId: 'r1' });

    await waitFor(() => {
      expect(refreshResourceThreads).toHaveBeenCalledTimes(1);
    });
  });

  it('does not refresh when the same projection is delivered again', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const { rerender } = renderSync(refreshResourceThreads);

    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    rerender({ enabled: true, resourceId: 'r1' });

    await Promise.resolve();
    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('treats the empty rows of a subscription that has not delivered as no delivery', async () => {
    // The aggregate always yields one row, so `[]` is "not delivered yet" (the render
    // right after the query is enabled), never an initial state to diff against.
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue({ error: null, loading: false, rows: [] });
    const { rerender } = renderSync(refreshResourceThreads);

    usePGliteLiveQueryMock.mockReturnValue(delivery(3, '2026-09-28 10:00:00+00'));
    rerender({ enabled: true, resourceId: 'r1' });

    await Promise.resolve();
    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('treats the first delivery for a different resource as initial', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const { rerender } = renderSync(refreshResourceThreads);

    usePGliteLiveQueryMock.mockReturnValue(delivery(5, '2026-09-28 11:00:00+00'));
    rerender({ enabled: true, resourceId: 'r2' });

    await Promise.resolve();
    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('subscribes to a resource-scoped projection, enabled only with the hook', () => {
    usePGliteLiveQueryMock.mockReturnValue(delivery(0, null));

    renderSync(vi.fn().mockResolvedValue(undefined), { enabled: false, resourceId: 'r9' });

    expect(usePGliteLiveQueryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cacheKey: 'assistant-thread-run-completions:r9',
        enabled: false,
        params: ['r9'],
      })
    );
  });

  it('does not refresh while disabled or without a repository', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const disabled = renderSync(refreshResourceThreads, { enabled: false });
    const detached = renderSync(refreshResourceThreads, { repository: null });

    usePGliteLiveQueryMock.mockReturnValue(delivery(2, '2026-09-28 10:05:00+00'));
    disabled.rerender({ enabled: false, resourceId: 'r1' });
    detached.rerender({ enabled: true, resourceId: 'r1' });

    await Promise.resolve();
    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('warns about a failed subscription and refreshes nothing', async () => {
    const refreshResourceThreads = vi.fn().mockResolvedValue(undefined);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const { rerender } = renderSync(refreshResourceThreads);

    const failure = new Error('subscription failed');
    usePGliteLiveQueryMock.mockReturnValue({
      error: failure,
      loading: false,
      rows: [{ lastCompletedAt: '2026-09-28 10:05:00+00', terminalCount: 2 }],
    });
    rerender({ enabled: true, resourceId: 'r1' });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Assistant thread run completion subscription failed',
      { error: failure, resourceId: 'r1' }
    );
    expect(refreshResourceThreads).not.toHaveBeenCalled();
  });

  it('surfaces a rejected refresh as a warning instead of an unhandled rejection', async () => {
    const failure = new Error('refresh failed');
    const refreshResourceThreads = vi.fn().mockRejectedValue(failure);
    usePGliteLiveQueryMock.mockReturnValue(delivery(1, '2026-09-28 10:00:00+00'));
    const { rerender } = renderSync(refreshResourceThreads);

    usePGliteLiveQueryMock.mockReturnValue(delivery(2, '2026-09-28 10:05:00+00'));
    rerender({ enabled: true, resourceId: 'r1' });

    await waitFor(() => {
      expect(loggerWarnMock).toHaveBeenCalledWith(
        'Failed to refresh assistant threads after a run completed',
        { error: failure, resourceId: 'r1' }
      );
    });
  });
});
