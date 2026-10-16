// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  deriveActivitySteps,
  readResultError,
  readToolFailure,
  stepVerbText,
  summarizeActivity,
  TOOL_EXECUTION_FAILED_MESSAGE,
  toolStepStateFor,
} from '../activity-trace-model';
import { verbForTool } from '../activity-verbs';

const VERB_STUB = verbForTool('stub');

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

  // Live QA 2026-10-16: "Using updateWorkingMemory # Session - **Active task**: …"
  // — a tool whose arguments carry content names no target, and the host's
  // meta tools name the argument that is one.
  it('reads each step’s target from the argument its verb names, never from content', () => {
    const memory = '# Session\n- **Active task**: ship the fix';
    const steps = deriveActivitySteps(
      [
        tool('m', 'updateWorkingMemory', { memory }, complete),
        tool('s', 'search_tools', { limit: 5, query: 'git worktree' }, complete),
        tool('l', 'load_tool', { toolName: 'brainstrike_manageWorktree' }, complete),
        // Codex review on #3723: load_tool's batch form names several tools.
        tool('b', 'load_tool', { toolNames: ['brainstrike_lspInspect', 'webSearch'] }, complete),
        tool('t', 'list_available_tools', { cursor: 'page-2' }, complete),
        tool(
          'c',
          'brainstrike.manageCanvas',
          { action: 'create', html: '<p/>', title: 'Plan' },
          complete
        ),
        tool(
          'u',
          'brainstrike.manageCanvas',
          { action: 'rewrite', canvasId: 'cv-1', html: '<h1>Plan</h1>' },
          complete
        ),
      ],
      {}
    );
    expect(steps.map((step) => [step.verb.done, step.target, step.targetKey])).toEqual([
      ['Updated memory', null, null],
      ['Searched tools', 'git worktree', 'git worktree'],
      ['Loaded tool', 'brainstrike_manageWorktree', 'brainstrike_manageWorktree'],
      ['Loaded tool', 'brainstrike_lspInspect, webSearch', 'brainstrike_lspInspect, webSearch'],
      ['Listed tools', null, null],
      ['Created canvas', 'Plan', 'Plan'],
      ['Updated canvas', null, null],
    ]);
  });

  it('marks a call the user declined or the host blocked as never having run', () => {
    const declined = {
      result: {
        kind: 'declined',
        message: 'The user declined this tool call, so it was not executed.',
      },
      status: { type: 'complete' },
    };
    const [step, stopped] = deriveActivitySteps(
      [
        tool('d', 'brainstrike.runSkillScript', { path: '.' }, declined),
        tool(
          'x',
          'brainstrike.executeCommand',
          { command: 'sleep 9' },
          {
            status: { reason: 'cancelled', type: 'incomplete' },
          }
        ),
      ],
      {}
    );
    expect(step).toMatchObject({ ran: false, state: 'cancelled' });
    expect(stepVerbText(step?.verb ?? VERB_STUB, 'cancelled', false)).toBe('Run skill script');
    // A call cut off mid-run keeps its "Stopped" reading in the past tense.
    expect(stopped).toMatchObject({ ran: true, state: 'cancelled' });
    expect(stepVerbText(stopped?.verb ?? VERB_STUB, 'cancelled', true)).toBe('Ran');
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

  it('reads a tool part with no status and no result as running', () => {
    const steps = deriveActivitySteps(
      [tool('n', 'brainstrike.executeCommand', { command: 'ls' })],
      {}
    );
    expect(steps[0]?.state).toBe('running');
  });

  // BST-1681 phase 3 SUPERSEDES the BST-1679 "canonical flags only" reading
  // for one shape: a settled result whose own `error` member states an error.
  // The tool card has always rendered that member as its red error line, so
  // leaving the trace on `done` meant one step reading Failed on the card and
  // counting as a success in the headline. One derivation, one verdict: both
  // now say `failed`. A payload that does NOT declare failure (an `ok: true`
  // result carrying advisory error metadata) is still ordinary data.
  it('counts a settled result that states its own error as failed on both surfaces', () => {
    const steps = deriveActivitySteps(
      [
        tool(
          'd',
          'brainstrike.executeCommand',
          { command: 'ls' },
          { result: { error: 'the command exploded' }, status: { type: 'complete' } }
        ),
      ],
      {}
    );
    expect(steps[0]?.state).toBe('failed');
    expect(summarizeActivity(steps).counts.failed).toBe(1);
  });

  it('never infers failure from advisory error metadata on a successful result', () => {
    const steps = deriveActivitySteps(
      [
        tool(
          'd',
          'brainstrike.executeCommand',
          { command: 'ls' },
          {
            result: { error: { message: 'advisory only' }, ok: true },
            status: { type: 'complete' },
          }
        ),
      ],
      {}
    );
    expect(steps[0]?.state).toBe('done');
    expect(summarizeActivity(steps).counts.failed).toBe(0);
  });

  it('never infers failure from an advisory error STRING on a successful result', () => {
    // Bot round 1 (Claude Important 1 / Codex P2 #1): `readResultError` reads
    // the success discriminator FIRST, so an `ok: true` envelope carrying a
    // human-readable advisory in `error` is ordinary domain data on every
    // surface. Reading the string first made this step Failed in the headline
    // while the card, whose error line renders only under failed chrome,
    // agreed — both were wrong about a result that says it succeeded.
    const steps = deriveActivitySteps(
      [
        tool(
          'd',
          'brainstrike.executeCommand',
          { command: 'ls' },
          { result: { error: 'warning: deprecated flag', ok: true }, status: { type: 'complete' } }
        ),
      ],
      {}
    );
    expect(steps[0]?.state).toBe('done');
    expect(summarizeActivity(steps).counts.failed).toBe(0);
  });

  it('maps incomplete with a non-cancelled reason to failed', () => {
    const steps = deriveActivitySteps(
      [
        tool(
          'e',
          'brainstrike.executeCommand',
          { command: 'ls' },
          { status: { reason: 'error', type: 'incomplete' } }
        ),
      ],
      {}
    );
    expect(steps[0]?.state).toBe('failed');
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

  it('reads the bare active verb with no trailing space when a running tool has no primary arg', () => {
    const steps = deriveActivitySteps([tool('b', 'brainstrike.grepSearch', {}, running)], {});
    expect(summarizeActivity(steps).live).toBe('Searching');
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

  // `waiting` is the CLOCK gate (and the sr-announcement's), deliberately
  // narrower than the label: the label answers "what is the header saying"
  // and a gate wins that race, but a run with another tool still executing is
  // not paused on the user — its elapsed time is real work and must keep
  // ticking. Pinned as a property of the summary so the two consumers in
  // activity-trace.tsx cannot re-derive it differently.
  it('flags waiting only when a gated step exists and no tool is still running', () => {
    const gate = tool(
      'w',
      'brainstrike.executeCommand',
      { command: 'rm -rf x' },
      { status: { reason: 'interrupt', type: 'requires-action' } }
    );
    const gatedOnly = summarizeActivity(deriveActivitySteps([gate], {}));
    expect(gatedOnly.live).toBe('Waiting for approval');
    expect(gatedOnly.waiting).toBe(true);

    const gatedWhileRunning = summarizeActivity(
      deriveActivitySteps(
        [gate, tool('r', 'brainstrike.grepSearch', { pattern: 'foo' }, running)],
        {}
      )
    );
    expect(gatedWhileRunning.live).toBe('Waiting for approval');
    expect(gatedWhileRunning.waiting).toBe(false);
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
      verbs: 'Read, searched',
      waiting: false,
    });
  });

  it('reads a singular file count for an edit family with exactly one distinct target', () => {
    const steps = deriveActivitySteps(
      [done('1', 'brainstrike.writeWorkspaceFile', { path: 'a.ts' })],
      {}
    );
    expect(summarizeActivity(steps).resting).toBe('Edited 1 file');
  });

  it('counts files for a delete from the first distinct target', () => {
    const steps = deriveActivitySteps(
      [done('1', 'brainstrike.deleteWorkspaceFile', { path: 'a.ts' })],
      {}
    );
    expect(summarizeActivity(steps).resting).toBe('Deleted 1 file');
  });

  // The fold is a property of the VERB (`countsFiles`), never of its family:
  // `read` also covers directory listings, artifact reads and context reads,
  // whose targets are not files, so folding the whole family read
  // "Listed 2 files" / "Read output 2 files" for them (review finding).
  it('never folds a file count onto a read-family verb whose target is not a file', () => {
    const listed = deriveActivitySteps(
      [
        done('1', 'brainstrike.readWorkspaceDirectory', { path: 'src' }),
        done('2', 'brainstrike.readWorkspaceDirectory', { path: 'docs' }),
      ],
      {}
    );
    expect(summarizeActivity(listed).resting).toBe('Listed');
    const artifacts = deriveActivitySteps(
      [
        done('1', 'brainstrike.readToolOutputArtifact', { id: 'artifact-1' }),
        done('2', 'brainstrike.readToolOutputArtifact', { id: 'artifact-2' }),
      ],
      {}
    );
    expect(summarizeActivity(artifacts).resting).toBe('Read output');
  });

  it('dedupes distinct-target counts on the untruncated arg, not the ellipsised display', () => {
    // Two paths that share the same first-24/last-39 characters — and so
    // collapse to the same middle-ellipsised `display` (see
    // tool-summaries.ts PATH_HEAD_LENGTH/PATH_TAIL_LENGTH) — but differ in
    // the middle, so they must still count as two distinct files.
    const prefix = 'p'.repeat(24);
    const suffix = 's'.repeat(39);
    const steps = deriveActivitySteps(
      [
        done('1', 'brainstrike.writeWorkspaceFile', { path: `${prefix}-alpha-${suffix}` }),
        done('2', 'brainstrike.writeWorkspaceFile', { path: `${prefix}-beta--${suffix}` }),
      ],
      {}
    );
    expect(steps[0]?.target).toBe(steps[1]?.target);
    expect(steps[0]?.targetKey).not.toBe(steps[1]?.targetKey);
    expect(summarizeActivity(steps).resting).toBe('Edited 2 files');
  });

  // `resting` is the HEADLINE (placeholder included); `verbs` is the verb
  // summary or nothing at all. The header demotes the verb summary to a
  // `· <verbs>` meta segment when `Stopped`/`Activity failed` takes the
  // headline, and demoting the placeholder read "Stopped after 4.0s · Worked"
  // (review finding 1) — so the two must stay distinguishable.
  it('reports verbs as null when no tool step settled, and as the resting headline when one did', () => {
    const unsettled = summarizeActivity(
      deriveActivitySteps(
        [
          tool(
            'c',
            'brainstrike.executeCommand',
            { command: 'ls' },
            { status: { reason: 'cancelled', type: 'incomplete' } }
          ),
        ],
        {}
      )
    );
    expect(unsettled.verbs).toBeNull();
    expect(unsettled.resting).toBe('Worked');

    const settled = summarizeActivity(
      deriveActivitySteps([done('1', 'brainstrike.readWorkspaceFile', { path: 'a.ts' })], {})
    );
    expect(settled.verbs).toBe('Read');
    expect(settled.verbs).toBe(settled.resting);
  });

  it('reads Thought for a reasoning-only group and Worked for an empty one', () => {
    expect(summarizeActivity(deriveActivitySteps([reasoning('x', 'complete')], {})).resting).toBe(
      'Thought'
    );
    expect(summarizeActivity([]).resting).toBe('Worked');
    expect(
      summarizeActivity(deriveActivitySteps([reasoning('x', 'complete')], {})).verbs
    ).toBeNull();
    expect(summarizeActivity([]).verbs).toBeNull();
  });
});

/**
 * BST-1681 phase 3: the tool CARD calls this same function, so a step can
 * never read one state on the card and another in the trace headline. Every
 * branch is pinned here because both surfaces now depend on it.
 */
describe('toolStepStateFor', () => {
  it('maps every status branch the card and the trace share', () => {
    expect(toolStepStateFor({ status: { type: 'running' } })).toBe('running');
    expect(toolStepStateFor({ status: { reason: 'tool-calls', type: 'requires-action' } })).toBe(
      'waiting'
    );
    expect(toolStepStateFor({ status: { reason: 'cancelled', type: 'incomplete' } })).toBe(
      'cancelled'
    );
    expect(toolStepStateFor({ status: { reason: 'error', type: 'incomplete' } })).toBe('failed');
    expect(toolStepStateFor({ isError: true, status: { type: 'complete' } })).toBe('failed');
    expect(toolStepStateFor({ status: { type: 'complete' } })).toBe('done');
    expect(toolStepStateFor({ result: { ok: true }, status: { type: 'complete' } })).toBe('done');
    expect(toolStepStateFor({})).toBe('running');
  });

  it('calls the card error shapes failed so both surfaces agree on failure', () => {
    // The card has always rendered an error line for these three shapes (its
    // own `readResultErrorMessage`, deleted in bot round 1 in favour of the
    // shared `readResultError`); before this ruling the trace read them as
    // `done`, so one step could be Failed on the card and a success in the
    // headline.
    expect(toolStepStateFor({ result: { error: 'boom' }, status: { type: 'complete' } })).toBe(
      'failed'
    );
    expect(
      toolStepStateFor({
        result: { error: { message: 'not a guarded code' }, ok: false },
        status: { type: 'complete' },
      })
    ).toBe('failed');
    expect(toolStepStateFor({ result: { isError: true }, status: { type: 'complete' } })).toBe(
      'failed'
    );
  });

  it('leaves a successful payload and a plain string result on the done path', () => {
    expect(
      toolStepStateFor({
        result: { error: { message: 'advisory only' }, ok: true },
        status: { type: 'complete' },
      })
    ).toBe('done');
    // The STRING form of the same advisory (bot round 1, Claude Important 1):
    // `ok: true` is the success discriminator and it is read first, so no
    // `error` member of any shape can contradict it.
    expect(
      toolStepStateFor({
        result: { error: 'warning: deprecated flag', ok: true },
        status: { type: 'complete' },
      })
    ).toBe('done');
    expect(toolStepStateFor({ result: 'plain string result', status: { type: 'complete' } })).toBe(
      'done'
    );
  });
});

/**
 * The two overrides that used to live in `tool-fallback.tsx`'s
 * `resolveCardStatus` (Task 4 review, Minor 1). While they sat there, a
 * declined call read `Stopped` on the card and counted as a `Completed` step
 * in the trace headline — the exact split this phase exists to close. They
 * ride strictly on TOP of a generic `done`, and only for the tool that owns
 * them, so the card has no state of its own left.
 */
describe('toolStepStateFor tool-specific overrides', () => {
  const DECLINED = {
    kind: 'declined',
    message: 'The user declined this tool call, so it was not executed.',
  };
  const streams = { stderr: '', stderrOmittedBytes: 0, stdout: '', stdoutOmittedBytes: 0 };

  it('reads a declined envelope as cancelled, for any tool', () => {
    expect(toolStepStateFor({ result: DECLINED, status: { type: 'complete' } })).toBe('cancelled');
    expect(
      toolStepStateFor({
        result: DECLINED,
        status: { type: 'complete' },
        toolName: 'brainstrike.executeCommand',
      })
    ).toBe('cancelled');
  });

  it('never counts a decline as a failure in the headline', () => {
    const steps = deriveActivitySteps(
      [
        tool(
          'd',
          'brainstrike.executeCommand',
          { command: 'rm -rf /' },
          { result: DECLINED, status: { type: 'complete' } }
        ),
      ],
      {}
    );
    expect(steps[0]?.state).toBe('cancelled');
    expect(summarizeActivity(steps).counts.failed).toBe(0);
  });

  it('maps a settled run_python result through its own five-state reading', () => {
    const state = (result: unknown) =>
      toolStepStateFor({
        result,
        status: { type: 'complete' },
        toolName: 'brainstrike.runPython',
      });
    expect(state({ ...streams, exitCode: 0, kind: 'completed' })).toBe('done');
    // A non-zero exit still COMPLETED the call; the amber "finished with an
    // error" belongs to the result surface, not to the step's state.
    expect(state({ ...streams, exitCode: 1, kind: 'completed' })).toBe('done');
    // Nothing ran at all — destructive.
    expect(
      state({ detail: 'no interpreter on PATH', kind: 'unavailable', reason: 'missing' })
    ).toBe('failed');
    // Stopped without completing: never a green check, never red either.
    expect(state({ ...streams, kind: 'cancelled', partialStderr: '', partialStdout: '' })).toBe(
      'cancelled'
    );
    expect(state({ ...streams, kind: 'killed', signal: 'SIGKILL' })).toBe('cancelled');
  });

  it('gates the run_python reading on the tool NAME, not the result shape', () => {
    // An MCP tool free to return `{kind: 'unavailable'}` as ordinary domain
    // data must not inherit run_python's failure reading.
    expect(
      toolStepStateFor({
        result: { detail: 'seat taken', kind: 'unavailable', reason: 'busy' },
        status: { type: 'complete' },
        toolName: 'booking.reserve',
      })
    ).toBe('done');
    expect(
      toolStepStateFor({
        result: { detail: 'seat taken', kind: 'unavailable', reason: 'busy' },
        status: { type: 'complete' },
      })
    ).toBe('done');
  });

  it('lets a malformed run_python shape fall through to the generic reading', () => {
    // Narrowing fails (no stream fields), so there is no honest structured
    // state to report — the generic `done` stands rather than an invented one.
    expect(
      toolStepStateFor({
        result: { kind: 'completed' },
        status: { type: 'complete' },
        toolName: 'brainstrike.runPython',
      })
    ).toBe('done');
  });

  it('keeps every non-done generic branch winning over both overrides', () => {
    // A transport abort mid-run_python, and a gate that has not been answered:
    // the structured result (if any) must never repaint either as settled.
    expect(
      toolStepStateFor({
        result: DECLINED,
        status: { reason: 'error', type: 'incomplete' },
        toolName: 'brainstrike.runPython',
      })
    ).toBe('failed');
    expect(
      toolStepStateFor({
        result: { ...streams, exitCode: 0, kind: 'completed' },
        status: { type: 'running' },
        toolName: 'brainstrike.runPython',
      })
    ).toBe('running');
  });
});

/**
 * The ONE reader of "this result states an error" (bot round 1, Claude
 * Important 2). `tool-fallback.tsx`'s error line and `toolStepStateFor`'s
 * failed verdict used to be two copies of the same shape list that had already
 * drifted on the `ok: true` case — the message reader returned the advisory
 * string and the state reader called the step failed. One function now answers
 * both questions: the state machine asks whether it returns a message at all,
 * the card renders the message it returns.
 */
describe('readResultError', () => {
  it('returns null for a result that does not state an error', () => {
    expect(readResultError(undefined)).toBeNull();
    expect(readResultError('plain string result')).toBeNull();
    expect(readResultError({ ok: true })).toBeNull();
    expect(readResultError([{ error: 'boom' }])).toBeNull();
    expect(readResultError({ error: '' })).toBeNull();
    expect(readResultError({ error: { message: 'boom' } })).toBeNull();
    expect(readResultError({ error: { message: '' }, ok: false })).toBeNull();
  });

  it('reads the success discriminator before any error member', () => {
    expect(readResultError({ error: 'warning: deprecated flag', ok: true })).toBeNull();
    expect(readResultError({ error: { message: 'advisory only' }, ok: true })).toBeNull();
  });

  it('returns the message a failing result states', () => {
    expect(readResultError({ error: 'boom' })).toBe('boom');
    expect(readResultError({ error: { message: 'boom' }, ok: false })).toBe('boom');
    expect(readResultError({ isError: true })).toBe(TOOL_EXECUTION_FAILED_MESSAGE);
  });
});

// Live QA 2026-10-16: an input the tool's schema refused showed only "Tool
// execution failed." — the AI SDK commits its tool-error as the error's own
// message string, which is the result of an errored part.
describe('readToolFailure', () => {
  const sdkRefusal =
    'Invalid input for tool brainstrike.runSkillScript: Must be a canonical root-relative path without traversal';

  it('reads an errored part’s string result as its stated failure', () => {
    expect(readToolFailure(sdkRefusal, true)).toBe(sdkRefusal);
  });

  it('keeps every shape readResultError reads, errored or not', () => {
    expect(readToolFailure({ error: 'boom' }, false)).toBe('boom');
    expect(readToolFailure({ error: { message: 'boom' }, ok: false }, true)).toBe('boom');
  });

  it('never reads a successful string result as a failure', () => {
    expect(readToolFailure('plain string result', false)).toBeNull();
  });

  it('says only that it failed when an errored part states nothing', () => {
    expect(readToolFailure({ name: 'ToolInputError' }, true)).toBe(TOOL_EXECUTION_FAILED_MESSAGE);
    expect(readToolFailure('   ', true)).toBe(TOOL_EXECUTION_FAILED_MESSAGE);
  });
});
