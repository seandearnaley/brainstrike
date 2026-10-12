import { registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { type QueryProcess, SqliteQueryClient } from '@brainstrike/sqlite-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXECUTION_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors-execution';

const { getDatabase, openIndexQuery } = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  openIndexQuery: vi.fn(),
}));
vi.mock('../../db-main', () => ({ getDatabase }));
vi.mock('../../sqlite-query-host-manager', () => ({ openIndexQuery }));

function reader() {
  let receive: (message: unknown) => void = () => undefined;
  let exit: () => void = () => undefined;
  const admitted = Promise.withResolvers<void>();
  const process: QueryProcess = {
    kill: vi.fn(),
    onError: () => () => undefined,
    onExit: (listener) => {
      exit = listener;
      return () => undefined;
    },
    onMessage: (listener) => {
      receive = listener;
      return () => undefined;
    },
    pid: 4321,
    postMessage: (request) => {
      if (request.kind === 'open') {
        queueMicrotask(() => receive({ id: request.id, kind: 'ready' }));
        return;
      }
      admitted.resolve();
    },
  };
  return { admitted, exit: () => exit(), process };
}

function executor() {
  const entry = EXECUTION_TOOL_EXECUTORS[NATIVE_TOOL_ID.querySelf]({
    dependencies: {},
    isLocalProvider: false,
    readFileCursorRegistry: {} as never,
    resolveActiveDomainCharBudget: () => 6000,
    resolvedDomainCharBudget: 6000,
    runtimeData: undefined,
  });
  if (!(entry && 'execute' in entry && entry.execute)) {
    throw new Error('querySelf executor is required.');
  }
  return entry.execute;
}

beforeEach(() => {
  getDatabase.mockReset();
  openIndexQuery.mockReset();
});

describe('querySelf public execution cancellation', () => {
  it.each(['app', 'index'] as const)(
    'does not acquire %s on an already aborted context',
    async (target) => {
      const controller = new AbortController();
      const reason = new Error('User Stop before admission.');
      controller.abort(reason);
      await expect(
        executor()({ mode: 'query', sql: 'SELECT 1', target }, { abortSignal: controller.signal })
      ).rejects.toBe(reason);
      expect(openIndexQuery).not.toHaveBeenCalled();
      expect(getDatabase).not.toHaveBeenCalled();
    }
  );

  it.each(['Stop', 'guard'] as const)(
    'propagates %s into the reader and waits for exit before rejecting',
    async (cause) => {
      const owner = reader();
      openIndexQuery.mockImplementation((signal?: AbortSignal) =>
        SqliteQueryClient.open({
          databasePath: '/recorded/index.sqlite',
          deadlineMs: 1000,
          signal,
          spawn: () => owner.process,
          startupDeadlineMs: 1000,
        })
      );
      const run = new AbortController();
      const guard = new AbortController();
      const context = { abortSignal: run.signal, toolCallId: `query-cancel-${cause}` };
      const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
      const outcome = executor()(
        { mode: 'query', sql: 'SELECT 1', target: 'index' },
        context
      ).catch((error: unknown) => error);
      try {
        await owner.admitted.promise;
        (cause === 'Stop' ? run : guard).abort(new Error(`Requested ${cause}`));
        expect(owner.process.kill).toHaveBeenCalledOnce();
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        owner.exit();
        expect(await outcome).toMatchObject({
          name: 'SqliteQueryCancelledError',
          ownerPid: 4321,
          phase: 'query',
          requestId: 2,
        });
        expect(owner.process.kill).toHaveBeenCalledOnce();
        expect(getDatabase).not.toHaveBeenCalled();
      } finally {
        release();
        owner.exit();
        await outcome;
      }
    }
  );
});
