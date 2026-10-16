// @vitest-environment node
import type { ThreadAssistantMessage } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import {
  activityFilterOptions,
  deriveActivityClusters,
  deriveLiveTail,
  deriveRunStrip,
  matchesActivityFilter,
  RUN_STRIP_MAX_MARKS,
} from '../activity-group-view-model';
import { type ActivityStep, deriveActivitySteps } from '../activity-trace-model';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import recording from './fixtures/committed-luna-long-tool-run.json';

type Call = readonly [
  toolName: string,
  args: Record<string, unknown>,
  outcome?: 'failed' | 'running',
];

/** Tool parts in the committed projection's shape, through the real step derivation. */
function steps(calls: readonly Call[], durations: Record<string, number> = {}): ActivityStep[] {
  return [
    ...deriveActivitySteps(
      calls.map(([toolName, args, outcome], index) => ({
        args,
        argsText: JSON.stringify(args),
        ...(outcome === 'running'
          ? { status: { type: 'running' } }
          : { status: { type: 'complete' } }),
        ...(outcome === 'running'
          ? {}
          : {
              isError: outcome === 'failed',
              result: outcome === 'failed' ? 'ENOENT' : { ok: true },
            }),
        toolCallId: `call-${index}`,
        toolName,
        type: 'tool-call',
      })),
      durations
    ),
  ];
}

const read = (path: string, outcome?: 'failed' | 'running'): Call =>
  outcome
    ? ['brainstrike.readWorkspaceFile', { path }, outcome]
    : ['brainstrike.readWorkspaceFile', { path }];
const grep = (pattern: string): Call => ['brainstrike.grepSearch', { pattern }];
const run = (command: string): Call => ['brainstrike.executeCommand', { command }];
const none: ReadonlySet<string> = new Set();

function recordedSteps(): readonly ActivityStep[] {
  const rows: readonly CommittedAssistantLogRow[] = recording;
  const start = rows.find(({ event }) => event['type'] === 'run.started');
  const runId = start?.event['runId'];
  if (!(start && typeof runId === 'string')) {
    throw new Error('The recording has no run.');
  }
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date(start.ts ?? 0),
      parentMessageId: null,
      userMessageId: 'recorded-prompt',
    }),
    threadId: start.threadId,
  });
  const answer = projection
    .acceptCommitted(rows)
    .repository.messages.find(({ message }) => message.id === runId)?.message as
    | ThreadAssistantMessage
    | undefined;
  return deriveActivitySteps(answer?.content ?? [], {});
}

describe('deriveActivityClusters', () => {
  it('folds the recorded Luna run’s twelve sequential reads and leaves the glob and grep alone', () => {
    const clusters = deriveActivityClusters(recordedSteps(), none);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      label: 'Read 12 files',
      morePreview: 9,
      preview: ['module-1.ts', 'module-2.ts', 'module-3.ts'],
    });
    expect(clusters[0]?.memberIds).toHaveLength(12);
  });

  it('folds from three consecutive same-verb calls, never two', () => {
    expect(deriveActivityClusters(steps([read('a.ts'), read('b.ts')]), none)).toEqual([]);
    expect(
      deriveActivityClusters(steps([read('a.ts'), read('b.ts'), read('c.ts')]), none)
    ).toHaveLength(1);
  });

  it('keeps a failure on its own row, splitting the run around it', () => {
    const run = steps([
      read('a.ts'),
      read('b.ts'),
      read('c.ts'),
      read('missing.ts', 'failed'),
      read('d.ts'),
      read('e.ts'),
      read('f.ts'),
    ]);
    const clusters = deriveActivityClusters(run, none);
    expect(clusters.map((cluster) => cluster.memberIds)).toEqual([
      ['call-0', 'call-1', 'call-2'],
      ['call-4', 'call-5', 'call-6'],
    ]);
  });

  it('never folds a running call, a different verb, a kept card or a delegation', () => {
    expect(
      deriveActivityClusters(steps([read('a.ts'), read('b.ts'), read('c.ts', 'running')]), none)
    ).toEqual([]);
    expect(
      deriveActivityClusters(steps([read('a.ts'), grep('x'), read('b.ts'), read('c.ts')]), none)
    ).toEqual([]);
    expect(
      deriveActivityClusters(steps([read('a.ts'), read('b.ts'), read('c.ts')]), new Set(['call-1']))
    ).toEqual([]);
    const delegations = steps([
      ['agent-explore', { prompt: 'a' }],
      ['agent-explore', { prompt: 'b' }],
      ['agent-explore', { prompt: 'c' }],
    ]);
    expect(deriveActivityClusters(delegations, none)).toEqual([]);
  });

  it('lets readable reasoning end a run so it keeps its place in the story', () => {
    const [a, b, c, d] = steps([read('a.ts'), read('b.ts'), read('c.ts'), read('d.ts')]);
    if (!(a && b && c && d)) {
      throw new Error('steps');
    }
    const thought: ActivityStep = { ...a, id: 'reasoning-9', kind: 'reasoning' };
    expect(deriveActivityClusters([a, b, thought, c, d], none)).toEqual([]);
  });

  it('names a cluster in the words of its verb', () => {
    const label = (calls: readonly Call[]) => deriveActivityClusters(steps(calls), none)[0]?.label;
    expect(label([read('a.ts'), read('a.ts'), read('b.ts')])).toBe('Read 2 files');
    expect(label([run('pnpm test'), run('pnpm lint'), run('pnpm build'), run('git status')])).toBe(
      'Ran 4 commands'
    );
    expect(label([grep('a'), grep('b'), grep('c')])).toBe('Searched 3 times');
  });

  it('sums a cluster’s duration only when every member reports one', () => {
    const calls = [read('a.ts'), read('b.ts'), read('c.ts')];
    expect(
      deriveActivityClusters(steps(calls, { 'call-0': 100, 'call-1': 200, 'call-2': 300 }), none)[0]
        ?.durationMs
    ).toBe(600);
    expect(
      deriveActivityClusters(steps(calls, { 'call-0': 100, 'call-1': 200 }), none)[0]?.durationMs
    ).toBeUndefined();
  });
});

describe('activityFilterOptions', () => {
  it('offers no bar below twenty tool steps', () => {
    expect(
      activityFilterOptions(steps(Array.from({ length: 19 }, (_v, i) => read(`${i}.ts`))))
    ).toEqual([]);
  });

  it('offers All, each family present in family order, then Failed', () => {
    const calls: Call[] = [
      ...Array.from({ length: 16 }, (_v, i) => read(`${i}.ts`)),
      grep('needle'),
      run('pnpm test'),
      run('pnpm lint'),
      read('gone.ts', 'failed'),
    ];
    const all = steps(calls);
    expect(activityFilterOptions(all)).toEqual([
      { count: 20, filter: 'all', label: 'All' },
      { count: 17, filter: 'read', label: 'Reads' },
      { count: 2, filter: 'run', label: 'Commands' },
      { count: 1, filter: 'search', label: 'Searches' },
      { count: 1, filter: 'failed', label: 'Failed' },
    ]);
    expect(all.filter((step) => matchesActivityFilter(step, 'failed')).map((s) => s.id)).toEqual([
      'call-19',
    ]);
    expect(all.filter((step) => matchesActivityFilter(step, 'run'))).toHaveLength(2);
  });
});

describe('deriveLiveTail', () => {
  it('keeps the three newest settled steps, oldest first, never the running one', () => {
    const tail = deriveLiveTail(
      steps([
        read('a.ts'),
        grep('x'),
        read('b.ts', 'failed'),
        run('pnpm test'),
        read('c.ts', 'running'),
      ])
    );
    expect(tail.map(({ state, target, verb }) => [verb, target, state])).toEqual([
      ['Searched', 'x', 'done'],
      ['Read', 'b.ts', 'failed'],
      ['Ran', 'pnpm test', 'done'],
    ]);
  });

  it('names a declined call by the action asked for, never as having run', () => {
    const [declined] = deriveActivitySteps(
      [
        {
          args: { path: '.' },
          argsText: '{"path":"."}',
          result: {
            kind: 'declined',
            message: 'The user declined this tool call, so it was not executed.',
          },
          status: { type: 'complete' },
          toolCallId: 'call-0',
          toolName: 'brainstrike.runSkillScript',
          type: 'tool-call',
        },
      ],
      {}
    );
    if (!declined) {
      throw new Error('No step derived');
    }
    expect(deriveLiveTail([declined])).toEqual([
      expect.objectContaining({ state: 'cancelled', verb: 'Run skill script' }),
    ]);
  });
});

describe('deriveRunStrip', () => {
  it('draws one mark per step for a run up to the cap, failures included', () => {
    const marks = deriveRunStrip(
      steps([...Array.from({ length: 8 }, (_v, i) => read(`${i}.ts`)), read('gone.ts', 'failed')])
    );
    expect(marks).toHaveLength(9);
    expect(marks.at(-1)).toEqual({ kind: 'failed', label: 'Read gone.ts', stepId: 'call-8' });
    expect(marks[0]?.kind).toBe('read');
  });

  it('draws nothing for a short run', () => {
    expect(deriveRunStrip(steps([read('a.ts'), read('b.ts')]))).toEqual([]);
  });

  it('buckets a 500-step run into the cap, and a failure still shows and opens itself', () => {
    const calls: Call[] = Array.from({ length: 500 }, (_v, i) =>
      i === 321 ? read(`${i}.ts`, 'failed') : read(`${i}.ts`)
    );
    const marks = deriveRunStrip(steps(calls));
    expect(marks.length).toBeLessThanOrEqual(RUN_STRIP_MAX_MARKS);
    const failed = marks.filter((mark) => mark.kind === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stepId).toBe('call-321');
  });
});
