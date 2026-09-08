import { describe, expect, it } from 'vitest';
import { deriveActivitySteps, summarizeActivity } from '../activity-trace-model';

const tool = (
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => ({
  args,
  argsText: JSON.stringify(args),
  toolCallId: id,
  toolName,
  type: 'tool-call' as const,
  ...extra,
});
const complete = { result: { ok: true }, status: { type: 'complete' } };
const running = { status: { type: 'running' } };
const reasoning = (text: string, status: 'running' | 'complete') => ({
  status: { type: status },
  text,
  type: 'reasoning' as const,
});

describe('deriveActivitySteps', () => {
  it('maps tool parts to steps with verb, target, state, and duration', () => {
    const steps = deriveActivitySteps(
      [
        tool('a', 'brainstrike.readWorkspaceFile', { path: 'src/app.ts' }, complete),
        tool('b', 'brainstrike.grepSearch', { pattern: 'foo' }, running),
      ],
      { a: 1500 }
    );
    expect(steps).toEqual([
      expect.objectContaining({
        durationMs: 1500,
        id: 'a',
        kind: 'tool',
        partIndex: 0,
        state: 'done',
        target: 'src/app.ts',
      }),
      expect.objectContaining({
        durationMs: undefined,
        id: 'b',
        kind: 'tool',
        partIndex: 1,
        state: 'running',
        target: 'foo',
      }),
    ]);
    expect(steps[0]?.verb.done).toBe('Read');
    expect(steps[1]?.verb.active).toBe('Searching');
  });

  it('maps statuses: requires-action → waiting, incomplete cancelled → cancelled, isError/guarded → failed', () => {
    const steps = deriveActivitySteps(
      [
        tool(
          'w',
          'brainstrike.executeCommand',
          { command: 'ls' },
          { status: { reason: 'interrupt', type: 'requires-action' } }
        ),
        tool(
          'c',
          'brainstrike.executeCommand',
          { command: 'ls' },
          { status: { reason: 'cancelled', type: 'incomplete' } }
        ),
        tool(
          'e',
          'brainstrike.executeCommand',
          { command: 'ls' },
          { isError: true, result: { error: 'boom' }, status: { type: 'complete' } }
        ),
        tool(
          'g',
          'brainstrike.executeCommand',
          { command: 'ls' },
          {
            result: {
              error: {
                code: 'tool_blocked_by_hook',
                message: 'blocked',
                toolName: 'brainstrike.executeCommand',
              },
              ok: false,
            },
            status: { type: 'complete' },
          }
        ),
      ],
      {}
    );
    expect(steps.map((step) => step.state)).toEqual(['waiting', 'cancelled', 'failed', 'failed']);
  });

  it('maps reasoning parts to Thinking/Thought steps that never count as tool steps', () => {
    const steps = deriveActivitySteps(
      [reasoning('hmm', 'running'), reasoning('done', 'complete')],
      {}
    );
    expect(steps.map((step) => [step.kind, step.state, step.verb.active, step.verb.done])).toEqual([
      ['reasoning', 'running', 'Thinking', 'Thought'],
      ['reasoning', 'done', 'Thinking', 'Thought'],
    ]);
    expect(summarizeActivity(steps).counts.steps).toBe(0);
  });

  it('ignores data and text parts', () => {
    expect(
      deriveActivitySteps(
        [
          { text: 'x', type: 'text' },
          { data: {}, name: 'brainstrike.run-event', type: 'data' },
        ],
        {}
      )
    ).toEqual([]);
  });
});

describe('summarizeActivity', () => {
  const done = (id: string, name: string, args: Record<string, unknown>) =>
    tool(id, name, args, complete);

  it('names the last running tool with its target while live', () => {
    const steps = deriveActivitySteps(
      [
        done('a', 'brainstrike.readWorkspaceFile', { path: 'a.ts' }),
        tool('b', 'brainstrike.grepSearch', { pattern: 'foo' }, running),
      ],
      {}
    );
    expect(summarizeActivity(steps).live).toBe('Searching foo');
  });

  it('prefers a waiting step over a running one and reads Waiting for approval', () => {
    const steps = deriveActivitySteps(
      [
        tool(
          'w',
          'brainstrike.executeCommand',
          { command: 'rm -rf x' },
          { status: { reason: 'interrupt', type: 'requires-action' } }
        ),
      ],
      {}
    );
    expect(summarizeActivity(steps).live).toBe('Waiting for approval');
  });

  it('reads Thinking while only reasoning streams and Working when nothing is identifiable', () => {
    expect(summarizeActivity(deriveActivitySteps([reasoning('x', 'running')], {})).live).toBe(
      'Thinking'
    );
    expect(summarizeActivity([]).live).toBe('Working');
  });

  it('builds the resting summary from unique verbs in first-occurrence order, capped at three', () => {
    const steps = deriveActivitySteps(
      [
        done('1', 'brainstrike.readWorkspaceFile', { path: 'a.ts' }),
        done('2', 'brainstrike.readWorkspaceFile', { path: 'b.ts' }),
        done('3', 'brainstrike.executeCommand', { command: 'pnpm test' }),
        done('4', 'brainstrike.writeWorkspaceFile', { path: 'a.ts' }),
        done('5', 'brainstrike.writeWorkspaceFile', { path: 'c.ts' }),
        done('6', 'brainstrike.webSearch', { query: 'x' }),
        done('7', 'brainstrike.manageCanvas', { title: 't' }),
      ],
      {}
    );
    const summary = summarizeActivity(steps);
    expect(summary.resting).toBe('Read 2 files, ran, edited 2 files +2 more');
    expect(summary.counts).toEqual({ failed: 0, steps: 7 });
  });

  it('counts failed steps and still lists their verbs', () => {
    const steps = deriveActivitySteps(
      [
        done('1', 'brainstrike.readWorkspaceFile', { path: 'a.ts' }),
        tool(
          '2',
          'brainstrike.grepSearch',
          { pattern: 'x' },
          { isError: true, result: { error: 'no' }, status: { type: 'complete' } }
        ),
      ],
      {}
    );
    expect(summarizeActivity(steps)).toEqual({
      counts: { failed: 1, steps: 2 },
      live: 'Working',
      resting: 'Read, searched',
    });
  });

  it('reads Thought for a reasoning-only group and Worked for an empty one', () => {
    expect(summarizeActivity(deriveActivitySteps([reasoning('x', 'complete')], {})).resting).toBe(
      'Thought'
    );
    expect(summarizeActivity([]).resting).toBe('Worked');
  });
});
