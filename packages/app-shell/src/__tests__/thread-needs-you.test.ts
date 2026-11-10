// @vitest-environment node
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import type { AssistantThreadHostRun } from '../assistant-thread-host-context';
import { buildThreadNeedsYouRows } from '../thread-needs-you';

function thread(id: string, minute: number): AssistantMemoryThread {
  const at = new Date(Date.UTC(2026, 10, 10, 12, minute));
  return { createdAt: at, id, resourceId: 'workspace', title: id, updatedAt: at };
}

function waiting(
  ...waitingOn: NonNullable<AssistantThreadHostRun['waitingOn']>
): AssistantThreadHostRun {
  return { completedAt: null, needsInput: true, startedAt: null, status: 'running', waitingOn };
}

const lastActivityAt = (candidate: AssistantMemoryThread): number => candidate.updatedAt.getTime();
const NONE: ReadonlySet<string> = new Set();

function rows(input: {
  readonly failedUnseen?: readonly string[];
  readonly hostRuns?: ReadonlyMap<string, AssistantThreadHostRun>;
  readonly needsYou?: readonly string[];
  readonly threads: readonly AssistantMemoryThread[];
  readonly unseen?: readonly string[];
}): readonly (readonly [string, string])[] {
  return buildThreadNeedsYouRows({
    failedUnseenThreadIds: input.failedUnseen ? new Set(input.failedUnseen) : NONE,
    hostRuns: input.hostRuns ?? new Map(),
    lastActivityAt,
    needsYouThreadIds: input.needsYou ? new Set(input.needsYou) : NONE,
    threads: input.threads,
    unseenThreadIds: input.unseen ? new Set(input.unseen) : NONE,
  }).map((row) => [row.thread.id, row.reason] as const);
}

describe('buildThreadNeedsYouRows', () => {
  it('lists every thread waiting on its person, and says which kind of wait each is', () => {
    expect(
      rows({
        failedUnseen: ['failed'],
        hostRuns: new Map([
          ['asked', waiting('question')],
          ['approval', waiting('approval')],
          ['planned', waiting('plan')],
        ]),
        needsYou: ['asked', 'approval', 'planned'],
        threads: [
          thread('idle', 9),
          thread('finished', 1),
          thread('failed', 2),
          thread('approval', 3),
          thread('asked', 4),
          thread('planned', 5),
        ],
        unseen: ['finished', 'failed'],
      })
    ).toEqual([
      // A run held on its person comes first, newest first: it is blocked.
      ['planned', 'plan'],
      ['asked', 'question'],
      ['approval', 'approval'],
      // Then what finished while they were away: a failure before a result.
      ['failed', 'failed'],
      ['finished', 'review'],
    ]);
  });

  it('is empty when nothing waits', () => {
    expect(rows({ threads: [thread('idle', 1), thread('other', 2)] })).toEqual([]);
  });

  it('asks a network consent as an approval, and leads with a question over an approval', () => {
    expect(
      rows({
        hostRuns: new Map([
          ['network', waiting('network')],
          ['both', waiting('approval', 'question')],
        ]),
        needsYou: ['network', 'both'],
        threads: [thread('network', 2), thread('both', 1)],
      })
    ).toEqual([
      ['network', 'approval'],
      ['both', 'question'],
    ]);
  });

  it('still lists a waiting thread whose host names no kind', () => {
    // An older host, or a projection that knows only that the run waits.
    expect(
      rows({
        hostRuns: new Map([
          ['waits', { completedAt: null, needsInput: true, startedAt: null, status: 'running' }],
        ]),
        needsYou: ['waits', 'unlisted-run'],
        threads: [thread('waits', 1), thread('unlisted-run', 2)],
      })
    ).toEqual([
      ['unlisted-run', 'input'],
      ['waits', 'input'],
    ]);
  });

  it('lists a thread once, as waiting, when it is also unseen', () => {
    expect(
      rows({
        hostRuns: new Map([['asked', waiting('question')]]),
        needsYou: ['asked'],
        threads: [thread('asked', 1)],
        unseen: ['asked'],
      })
    ).toEqual([['asked', 'question']]);
  });
});
