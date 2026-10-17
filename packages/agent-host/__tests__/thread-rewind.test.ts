import { Schema } from 'effect';
/**
 * Restore to before a message (gap 2): the rewind module over real run state
 * and committed rows. Its ports record what Core would commit, folding each
 * committed event back into the module as Core's own fold does.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHostRunState, type HostRunState } from '../src/core-state.js';
import type { HostPlatform, HostRewindFiles } from '../src/ports.js';
import { type HostEvent, HostLogRowSchema, type HostTurnSnapshot } from '../src/protocol.js';
import { HostThreadRewinds } from '../src/thread-rewind.js';

const THREAD = 'thread-1';
const oid = (digit: string) => digit.repeat(40);
function turnStart(runId: string, roots: readonly HostTurnSnapshot[], failure?: string) {
  const row = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    event: {
      boundary: 'turn-start',
      ...(failure ? { failure } : {}),
      roots,
      runId,
      type: 'workspace.snapshot.recorded',
    },
    seq: 1,
    threadId: THREAD,
  });
  if (row.event.type !== 'workspace.snapshot.recorded') {
    throw new Error('the fixture builds a turn snapshot');
  }
  return row.event;
}
/** A finished run answering `messageId`, after `parent`. */
function run(
  id: string,
  messageId: string,
  parent: string | null,
  roots?: readonly HostTurnSnapshot[]
): HostRunState {
  const state = createHostRunState(
    THREAD,
    id,
    'model',
    { parentMessageId: parent, prompt: `prompt for ${id}`, userMessageId: messageId },
    { sessionGrants: [] } as never
  );
  state.terminal = true;
  if (roots) {
    state.turnStart = turnStart(id, roots);
  }
  return state;
}
const ROOT_A = { rootId: 'root-a', rootPath: '/work/a' };
const ROOT_B = { rootId: 'root-b', rootPath: '/work/b' };
function harness(options: { readonly files?: Partial<HostRewindFiles> | false } = {}) {
  const runs = new Map<string, HostRunState>();
  const committed: HostEvent[] = [];
  const order: string[] = [];
  let seq = 0;
  const files: HostRewindFiles = {
    apply: vi.fn(async () => {
      order.push('apply');
      return [{ path: 'a.txt', rootId: 'root-a', status: 'restored' as const }];
    }),
    drift: vi.fn(async () => []),
    preview: vi.fn(async () => ({ previewId: 'preview-1' })),
    redo: vi.fn(async () => {
      order.push('redo');
      return [{ path: 'a.txt', rootId: 'root-a', status: 'restored' as const }];
    }),
    redoConflicts: vi.fn(async () => []),
    ...(options.files === false ? {} : options.files),
  };
  const platform = {
    ...(options.files === false ? {} : { rewindFiles: files }),
  } as HostPlatform;
  const commit = (events: readonly HostEvent[]): void => {
    for (const event of events) {
      seq += 1;
      order.push(event.type);
      committed.push(event);
      rewinds.fold(
        Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
          event,
          seq,
          threadId: THREAD,
        })
      );
    }
  };
  const rewinds: HostThreadRewinds = new HostThreadRewinds({
    accept: async (_threadId, _method, _params, _result, events) => commit(events),
    append: async (_threadId, events) => commit(events),
    command: (_method, _params, perform) => perform(),
    owner: () => ({ pending: new Map(), platform, runs }),
  });
  const add = (state: HostRunState): void => {
    runs.set(state.id, state);
    rewinds.fold(
      Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
        event: {
          modelId: 'model',
          parentMessageId: state.branch.parentMessageId,
          prompt: state.branch.prompt,
          runId: state.id,
          type: 'run.started',
        },
        seq: ++seq,
        threadId: THREAD,
      })
    );
  };
  return { add, committed, files, order, rewinds, runs };
}
/** Three runs in a row; the second message's turn starts with root A, the third adds root B. */
function threeTurns(h: ReturnType<typeof harness>): void {
  h.add(run('run-1', 'msg-1', null, [{ ...ROOT_A, commitOid: oid('1') }]));
  h.add(run('run-2', 'msg-2', 'run-1', [{ ...ROOT_A, commitOid: oid('2') }]));
  h.add(
    run('run-3', 'msg-3', 'run-2', [
      { ...ROOT_A, commitOid: oid('3') },
      { ...ROOT_B, commitOid: oid('4') },
    ])
  );
}
describe('restore to before a message', () => {
  it('previews the runs leaving the conversation and each root restore point', async () => {
    const h = harness();
    threeTurns(h);
    const preview = await h.rewinds.preview({ messageId: 'msg-2', threadId: THREAD });
    expect(preview).toEqual({
      files: {
        available: true,
        fromRunId: 'run-2',
        previewId: 'preview-1',
        // Root B, first seen later, restores to its first turn start after the target.
        roots: [
          { ...ROOT_A, commitOid: oid('2') },
          { ...ROOT_B, commitOid: oid('4') },
        ],
      },
      headId: 'run-1',
      runIds: ['run-2', 'run-3'],
    });
    expect(h.committed).toEqual([]);
  });
  it('commits a files rewind as intent, restore, then outcome, and moves the tip back', async () => {
    const h = harness();
    threeTurns(h);
    const result = await h.rewinds.rewind({
      commandId: 'cmd-1',
      messageId: 'msg-2',
      mode: 'conversation-and-files',
      previewId: 'preview-1',
      threadId: THREAD,
    });
    expect(result).toMatchObject({ status: 'rewound' });
    expect(h.order).toEqual(['thread.rewind.started', 'apply', 'thread.rewound']);
    expect(h.committed[0]).toMatchObject({ headId: 'run-1', messageId: 'msg-2', runId: 'run-2' });
    expect(h.rewinds.tip(THREAD)).toBe('run-1');
    // A start without a parent follows the rewound tip; an explicit parent is kept.
    expect(h.rewinds.position({ threadId: THREAD })).toEqual({
      parentMessageId: 'run-1',
      threadId: THREAD,
    });
    expect(h.rewinds.position({ parentMessageId: 'run-3', threadId: THREAD })).toMatchObject({
      parentMessageId: 'run-3',
    });
  });
  it('answers conflicts without committing anything until they are acknowledged', async () => {
    const h = harness({ files: { drift: async () => [{ path: 'a.txt', rootId: 'root-a' }] } });
    threeTurns(h);
    const params = {
      commandId: 'cmd-1',
      messageId: 'msg-2',
      mode: 'conversation-and-files' as const,
      previewId: 'preview-1',
      threadId: THREAD,
    };
    expect(await h.rewinds.rewind(params)).toEqual({
      conflicts: [{ path: 'a.txt', rootId: 'root-a' }],
      status: 'conflicts',
    });
    expect(h.committed).toEqual([]);
    await h.rewinds.rewind({ ...params, acknowledgeConflicts: true });
    expect(h.order).toEqual(['thread.rewind.started', 'apply', 'thread.rewound']);
  });
  it('commits a failed restore as interrupted, and keeps the rewind redoable', async () => {
    const h = harness({
      files: {
        apply: async () => {
          throw new Error('disk unavailable');
        },
      },
    });
    threeTurns(h);
    const result = await h.rewinds.rewind({
      commandId: 'cmd-1',
      messageId: 'msg-2',
      mode: 'conversation-and-files',
      previewId: 'preview-1',
      threadId: THREAD,
    });
    expect(result).toMatchObject({ detail: 'disk unavailable', status: 'interrupted' });
    expect(h.committed.at(-1)).toMatchObject({
      phase: 'rewind',
      type: 'thread.rewind.interrupted',
    });
    expect(h.rewinds.tip(THREAD)).toBe('run-1');
    const rewindId =
      h.committed[0]?.type === 'thread.rewind.started' ? h.committed[0].rewindId : '';
    await expect(
      h.rewinds.redo({ commandId: 'cmd-2', rewindId, threadId: THREAD })
    ).resolves.toMatchObject({ status: 'redone' });
  });
  it('commits interrupted for a started rewind the host never finished, on recovery', async () => {
    const h = harness();
    threeTurns(h);
    h.rewinds.fold(
      Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
        event: {
          commandId: 'cmd-1',
          headId: 'run-1',
          messageId: 'msg-2',
          mode: 'conversation-and-files',
          rewindId: 'rewind-1',
          runId: 'run-2',
          type: 'thread.rewind.started',
        },
        seq: 100,
        threadId: THREAD,
      })
    );
    await h.rewinds.recover();
    expect(h.committed).toEqual([
      expect.objectContaining({
        phase: 'rewind',
        rewindId: 'rewind-1',
        type: 'thread.rewind.interrupted',
      }),
    ]);
    // Once interrupted, it counts as applied: the tip is back, and nothing is pending.
    expect(h.rewinds.tip(THREAD)).toBe('run-1');
    await h.rewinds.recover();
    expect(h.committed).toHaveLength(1);
  });
  it('redoes the newest rewind as intent, restore, then outcome; a new run ends redo', async () => {
    const h = harness();
    threeTurns(h);
    const first = await h.rewinds.rewind({
      commandId: 'cmd-1',
      messageId: 'msg-3',
      mode: 'conversation-and-files',
      previewId: 'preview-1',
      threadId: THREAD,
    });
    const rewindId = first.status === 'rewound' ? first.rewindId : '';
    h.order.length = 0;
    await h.rewinds.redo({ commandId: 'cmd-2', rewindId, threadId: THREAD });
    expect(h.order).toEqual(['thread.rewind.redo.started', 'redo', 'thread.rewind.redone']);
    expect(h.rewinds.tip(THREAD)).toBeUndefined();
    const second = await h.rewinds.rewind({
      commandId: 'cmd-3',
      messageId: 'msg-3',
      mode: 'conversation-only',
      threadId: THREAD,
    });
    h.add(run('run-4', 'msg-4', 'run-2'));
    await expect(
      h.rewinds.redo({
        commandId: 'cmd-4',
        rewindId: second.status === 'rewound' ? second.rewindId : '',
        threadId: THREAD,
      })
    ).rejects.toThrow("Only the thread's newest rewind can be redone");
    expect(h.rewinds.tip(THREAD)).toBeUndefined();
  });
  it('refuses visibly: an active run, a target off the branch, no snapshot owner, a failed capture', async () => {
    const active = harness();
    threeTurns(active);
    const running = run('run-4', 'msg-4', 'run-3');
    running.terminal = false;
    active.add(running);
    await expect(active.rewinds.preview({ messageId: 'msg-2', threadId: THREAD })).rejects.toThrow(
      'active run'
    );
    const branched = harness();
    threeTurns(branched);
    // An edit of message 2 branches from run 1; run 3 is now off the tip's branch.
    branched.add(run('run-5', 'msg-5', 'run-1'));
    await expect(
      branched.rewinds.preview({ messageId: 'msg-3', threadId: THREAD })
    ).rejects.toThrow("not on the thread's current branch");
    const cli = harness({ files: false });
    threeTurns(cli);
    expect(await cli.rewinds.preview({ messageId: 'msg-2', threadId: THREAD })).toMatchObject({
      files: { available: false, reason: 'This host has no workspace snapshot owner' },
    });
    await expect(
      cli.rewinds.rewind({
        commandId: 'cmd-1',
        messageId: 'msg-2',
        mode: 'conversation-and-files',
        previewId: 'preview-1',
        threadId: THREAD,
      })
    ).rejects.toThrow('no workspace snapshot owner');
    expect(cli.committed).toEqual([]);
    const failed = harness();
    failed.add(run('run-1', 'msg-1', null, [{ ...ROOT_A, commitOid: oid('0') }]));
    expect(await failed.rewinds.preview({ messageId: 'msg-1', threadId: THREAD })).toMatchObject({
      files: { available: false, reason: expect.stringContaining('failed') },
    });
  });
});
