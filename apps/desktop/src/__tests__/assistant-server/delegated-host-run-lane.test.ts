/**
 * Live GLM run 22 (2026-09-15): an 82 s HNSW build held the DB host while four
 * children streamed. The delegated conversation host read its scope and step
 * budget on the owner database handle, so those queries went straight to the
 * busy host, hit its 30 s request timeout, and failed two children. Run-scoped
 * host work belongs on the run-critical foreground lane
 * (assistant-persistence.md): it waits its turn in the serial work scheduler.
 */
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDesktopMastraMemory,
  resetDesktopMastraMemoryCacheForTests,
} from '../../assistant-server/mastra-memory';
import {
  getDesktopDatabaseWorkSchedulerSnapshot,
  resetDesktopDatabaseWorkSchedulerForTests,
  runDesktopScheduledDatabaseWork,
} from '../../platform/desktop-database-work';
import { mockDesktopDatabase } from './_assistant-server-mocks';

const mocks = vi.hoisted(() => () => import('./_assistant-server-mocks'));
vi.mock('../../mcp-loader', async () => (await mocks()).makeMcpLoaderMock());
vi.mock('../../agent-client-loader', async () => (await mocks()).makeAgentClientLoaderMock());
vi.mock('../../secrets', async () => (await mocks()).makeSecretsMock());
vi.mock('@brainstrike/agent/hosted-web', async () => (await mocks()).makeHostedWebAgentMock());
vi.mock('@brainstrike/agent', async () => (await mocks()).makeAgentMock());
vi.mock('@brainstrike/agent/pglite-mastra-memory', async () =>
  (await mocks()).makePgliteMastraMemoryMock()
);
vi.mock('../../assistant-server/assistant-tools', async () =>
  (await mocks()).makeAssistantToolsMock()
);
vi.mock('../../assistant-server/workspace-text-file-reader', async () =>
  (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const SCOPE_READ = 'FROM brainstrike_assistant_thread_runs runs';

function scopeReads(): number {
  return mockDesktopDatabase.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes(SCOPE_READ)
  ).length;
}

beforeEach(() => {
  resetDesktopDatabaseWorkSchedulerForTests();
  resetDesktopMastraMemoryCacheForTests();
  mockDesktopDatabase.query.mockReset();
  mockDesktopDatabase.query.mockImplementation(async (sql) =>
    typeof sql === 'string' && sql.includes(SCOPE_READ)
      ? {
          rows: [
            { ownerResourceId: 'owner', rootThreadId: 'root-thread', turnMessageId: 'turn-1' },
          ],
        }
      : { rows: [] }
  );
});

afterEach(() => {
  resetDesktopMastraMemoryCacheForTests();
});

describe('delegated conversation host database lane', () => {
  it('queues its run-time queries behind database work that holds the lane', async () => {
    const memory = await getDesktopMastraMemory(undefined, 'run-lane');
    const resolveParkedInvocation = memory.conversationBinding?.resolveParkedInvocation;
    if (!resolveParkedInvocation) {
      throw new Error('Run-scoped desktop memory built no delegated conversation binding.');
    }
    const release = Promise.withResolvers<void>();
    const held = runDesktopScheduledDatabaseWork(
      { label: 'held-maintenance', priority: 'background' },
      () => release.promise
    );
    for (let turn = 0; turn < 50; turn += 1) {
      if (getDesktopDatabaseWorkSchedulerSnapshot().runningLabel === 'held-maintenance') {
        break;
      }
      await nextEventLoopTurn();
    }
    expect(getDesktopDatabaseWorkSchedulerSnapshot().runningLabel).toBe('held-maintenance');

    const parked = resolveParkedInvocation({
      parentRuntimeRunId: 'native-root',
      parentThreadId: 'root-thread',
      parentToolCallId: 'delegate-call',
    });
    for (let turn = 0; turn < 10; turn += 1) {
      await nextEventLoopTurn();
    }
    expect(scopeReads()).toBe(0);

    release.resolve();
    await held;
    // The fixture database owns no root, so the read fails once it runs; what
    // this pins is WHEN it runs.
    await expect(parked).rejects.toThrow(DelegatedConversationIdentityError);
    expect(scopeReads()).toBe(1);
  });
});
