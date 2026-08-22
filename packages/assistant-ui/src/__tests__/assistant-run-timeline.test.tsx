import type { AssistantRunEventKind } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  ASSISTANT_RUN_EVENT_KINDS,
} from '@brainstrike/assistant-contract';
import { UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND } from '@brainstrike/assistant-contract/tool-suspend';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveAssistantRunEventRows,
  getMatchingCompletedKind,
  getMatchingFailedKind,
  isAlwaysVisibleRunEvent,
  resolveAssistantRunEventRenderPlan,
  resolveAssistantRunEventStatus,
} from '../assistant-run-event-derivation';
import { AssistantRunTimeline } from '../assistant-run-timeline';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

function renderTimeline(data: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <AssistantRunTimeline data={data} />
    </TooltipProvider>
  );
}

function runEventPart(event: Record<string, unknown>) {
  return { data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME };
}

function countedParts(parts: unknown[], reads: { count: number }): unknown[] {
  return new Proxy(parts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads.count += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('deriveAssistantRunEventRows', () => {
  it('scans message parts once for every row in an update', () => {
    const reads = { count: 0 };
    const started = Array.from({ length: 40 }, (_, index) => ({
      id: `start-${index}`,
      kind: 'memory.observation.started',
      label: 'Observation started',
      status: 'running',
      timestamp: `2026-06-05T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const completed = started.map((event, index) => ({
      ...event,
      id: `complete-${index}`,
      kind: 'memory.observation.completed',
      label: `Observation completed ${index}`,
      status: 'completed',
    }));
    const parts = countedParts([...started, ...completed].map(runEventPart), reads);

    const rows = deriveAssistantRunEventRows([{ id: 'message-1', parts }]);

    expect(reads.count).toBe(parts.length);
    expect(rows.statuses['start-0']).toBe('completed');
    expect(rows.renderPlanKeys['start-0']).toBe('hidden');
    expect(rows.statuses['complete-0']).toBe('completed');
    expect(rows.renderPlanKeys['complete-0']).toBe('visible:1');
  });

  it('matches the established per-row status and render-plan behavior', () => {
    const events = [
      {
        id: 'run-start',
        kind: 'run.started',
        label: 'Run',
        runId: 'run-1',
        status: 'running',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        id: 'tool-start',
        kind: 'tool.started',
        label: 'Read',
        metadata: { toolCallId: 'call-1' },
        runId: 'run-1',
        status: 'running',
        timestamp: '2026-06-05T00:00:01.000Z',
      },
      {
        id: 'tool-done',
        kind: 'tool.completed',
        label: 'Read complete',
        metadata: { toolCallId: 'call-1' },
        runId: 'run-1',
        status: 'completed',
        timestamp: '2026-06-05T00:00:02.000Z',
      },
      {
        id: 'repeat-1',
        kind: 'memory.working.loaded',
        label: 'Memory read',
        status: 'info',
        timestamp: '2026-06-05T00:00:03.000Z',
      },
      {
        id: 'repeat-2',
        kind: 'memory.working.loaded',
        label: 'Memory read',
        status: 'info',
        timestamp: '2026-06-05T00:00:04.000Z',
      },
      {
        id: 'run-done',
        kind: 'run.finished',
        label: 'Done',
        runId: 'run-1',
        status: 'completed',
        timestamp: '2026-06-05T00:00:05.000Z',
      },
    ];
    const messages = [
      {
        parts: [
          ...events.map(runEventPart),
          { toolCallId: 'call-1', toolName: 'brainstrike.readFile', type: 'tool-call' },
        ],
      },
    ];
    const rows = deriveAssistantRunEventRows(messages);

    for (const event of events) {
      const expectedPlan = resolveAssistantRunEventRenderPlan(messages, event);
      expect(rows.statuses[event.id]).toBe(
        resolveAssistantRunEventStatus(messages, event as never)
      );
      expect(rows.renderPlanKeys[event.id]).toBe(
        expectedPlan.hidden ? 'hidden' : `visible:${expectedPlan.repeatCount}`
      );
    }
  });

  it('keeps the unanswerable-pause rejection visible despite its tool card (BST-558)', () => {
    // The Developer path. `initialRenderPlanKey` mirrors
    // `resolveAssistantRunEventRenderPlan`'s card suppression, so it must also
    // mirror the always-visible exemption — otherwise raising the Detail level
    // HIDES a row the default level shows. The `tool-call` part below is the
    // one `DataStreamMapper.handleToolSuspendRequired` always emits for the
    // suspended call, so this is the real thread shape, not a synthetic one.
    const rejected = {
      id: 'reject-1',
      kind: UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
      label: 'Tool pause cannot be answered by this build',
      metadata: { toolCallId: 'call-future', toolName: 'brainstrike.someFutureSuspendingTool' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const carded = {
      id: 'tool-failed-1',
      kind: 'tool.failed',
      label: 'Tool failed',
      metadata: { toolCallId: 'call-ordinary', toolName: 'brainstrike.readFile' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:02.000Z',
    };
    const messages = [
      {
        parts: [
          runEventPart(rejected),
          runEventPart(carded),
          {
            toolCallId: 'call-future',
            toolName: 'brainstrike.someFutureSuspendingTool',
            type: 'tool-call',
          },
          { toolCallId: 'call-ordinary', toolName: 'brainstrike.readFile', type: 'tool-call' },
        ],
      },
    ];

    const rows = deriveAssistantRunEventRows(messages);

    expect(rows.renderPlanKeys[rejected.id]).toBe('visible:1');
    // CONTROL: an ordinary carded tool.failed is still suppressed.
    expect(rows.renderPlanKeys[carded.id]).toBe('hidden');
  });
});

describe('getMatchingCompletedKind', () => {
  it('maps run.step.started to run.step.finished (not .completed)', () => {
    expect(getMatchingCompletedKind('run.step.started')).toBe('run.step.finished');
  });
  it('keeps run.started -> run.finished and tool.started -> tool.completed', () => {
    expect(getMatchingCompletedKind('run.started')).toBe('run.finished');
    expect(getMatchingCompletedKind('tool.started')).toBe('tool.completed');
  });
  it('maps non-run *.started to *.completed', () => {
    expect(getMatchingCompletedKind('memory.semantic.started')).toBe('memory.semantic.completed');
  });
});

describe('run-event terminal pairing contract', () => {
  const STARTED_KINDS = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.endsWith('.started'));
  const declares = (kind: string): kind is AssistantRunEventKind =>
    (ASSISTANT_RUN_EVENT_KINDS as readonly string[]).includes(kind);
  const stemOf = (kind: string) => kind.slice(0, -'.started'.length);

  // The pairing the helpers MUST produce, written out so a rename on either
  // side (contract kind or helper) fails here instead of drifting silently.
  // `subagent.started` is the case that regressed: its terminals are
  // `.finished`/`.failed`, never the `.completed` a suffix rewrite invents.
  const PAIRINGS = [
    ['memory.observation.started', 'memory.observation.completed', 'memory.observation.failed'],
    ['memory.reflection.started', 'memory.reflection.completed', null],
    ['memory.semantic.started', 'memory.semantic.completed', null],
    ['run.started', 'run.finished', 'run.failed'],
    ['run.step.started', 'run.step.finished', null],
    ['subagent.started', 'subagent.finished', 'subagent.failed'],
    ['subagent.tool.started', 'subagent.tool.completed', 'subagent.tool.failed'],
    ['tool.started', 'tool.completed', 'tool.failed'],
  ] as const;

  it('tables exactly the .started kinds the contract declares', () => {
    // Exhaustive, not a floor: a new declared `.started` kind fails HERE with
    // "add me to the table" rather than being covered only by the generic
    // loops below, which would let the table quietly stop being the full map
    // it advertises. Also catches a silently narrowed STARTED_KINDS filter.
    expect([...STARTED_KINDS].sort()).toEqual(PAIRINGS.map(([started]) => started).sort());
  });

  it.each(PAIRINGS)('pairs %s with %s / %s', (started, completed, failed) => {
    expect(getMatchingCompletedKind(started)).toBe(completed);
    expect(getMatchingFailedKind(started)).toBe(failed);
  });

  it('never pairs a .started kind with a terminal the contract does not declare', () => {
    for (const started of STARTED_KINDS) {
      const completed = getMatchingCompletedKind(started);
      const failed = getMatchingFailedKind(started);
      // A success terminal is mandatory: without one, a running row can only be
      // closed by the generic end-of-run fallbacks (or, when the failure
      // pairing is also absent, not at all — it spins for the whole run).
      expect(completed).not.toBeNull();
      expect(declares(completed as string)).toBe(true);
      if (failed !== null) {
        expect(declares(failed)).toBe(true);
      }
    }
  });

  it('pairs a failure terminal exactly when the contract declares one', () => {
    for (const started of STARTED_KINDS) {
      expect(getMatchingFailedKind(started) === null).toBe(!declares(`${stemOf(started)}.failed`));
    }
  });

  it('leaves no .started kind with an ambiguous success terminal', () => {
    // Both spellings are tried, so a namespace declaring `.completed` AND
    // `.finished` would make the lookup order load-bearing. None may.
    for (const started of STARTED_KINDS) {
      const stem = stemOf(started);
      expect([declares(`${stem}.completed`), declares(`${stem}.finished`)]).not.toEqual([
        true,
        true,
      ]);
    }
  });

  it('returns null for kinds that are not .started', () => {
    for (const kind of ASSISTANT_RUN_EVENT_KINDS.filter((k) => !k.endsWith('.started'))) {
      expect(getMatchingCompletedKind(kind)).toBeNull();
      expect(getMatchingFailedKind(kind)).toBeNull();
    }
  });
});

describe('isAlwaysVisibleRunEvent', () => {
  const ts = '2026-06-16T10:00:00.000Z';
  const event = (kind: string, status: string) => ({
    id: 'e',
    kind,
    label: kind,
    status,
    timestamp: ts,
  });

  it('forces run-level failure and cancellation rows to stay visible', () => {
    expect(isAlwaysVisibleRunEvent(event('run.failed', 'failed'))).toBe(true);
    expect(isAlwaysVisibleRunEvent(event('run.cancelled', 'cancelled'))).toBe(true);
  });

  it('forces the unanswerable-tool-pause rejection to stay visible (BST-558)', () => {
    // `tool.resume.unsupported` is the ONLY durable surface for a suspending
    // tool this build has no resume UI for: the `brainstrike.tool-suspend`
    // notice is transient, so after a reload this row is all that is left.
    expect(isAlwaysVisibleRunEvent(event('tool.resume.unsupported', 'failed'))).toBe(true);
  });

  it('forces the approval pause to stay visible (BST-1402)', () => {
    // The `brainstrike.tool-approval` notice that prompts the user is `aui-data`
    // — gone after a reload — so this row is the only surviving record that the
    // run stopped and asked. It is a `tool.*` kind carrying the paused call's
    // `toolCallId`, so without the exemption the mapper's `tool-call` part would
    // suppress it as "already carded".
    expect(isAlwaysVisibleRunEvent(event('tool.approval.requested', 'running'))).toBe(true);
  });

  it('does not force background bookkeeping or already-carded tool failures', () => {
    // tool.failed already surfaces on its ToolFallback card — never double-report.
    expect(isAlwaysVisibleRunEvent(event('tool.failed', 'failed'))).toBe(false);
    expect(isAlwaysVisibleRunEvent(event('memory.semantic.completed', 'completed'))).toBe(false);
    expect(isAlwaysVisibleRunEvent(event('run.finished', 'completed'))).toBe(false);
    expect(isAlwaysVisibleRunEvent(event('run.started', 'running'))).toBe(false);
  });

  it('returns false for non-run-event data', () => {
    expect(isAlwaysVisibleRunEvent(null)).toBe(false);
    expect(isAlwaysVisibleRunEvent({ kind: 'run.failed' })).toBe(false);
  });
});

describe('resolveAssistantRunEventStatus', () => {
  it('resolves a running generation step to completed when a finished event follows', () => {
    const started = {
      id: 'e1',
      kind: 'run.step.started',
      label: 'Generation step started',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const finished = {
      id: 'e2',
      kind: 'run.step.finished',
      label: 'Generation step completed',
      status: 'completed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [
      { parts: [runEventPart(started), runEventPart(finished)], role: 'assistant' },
    ];
    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('completed');
  });

  it('leaves tool.started RUNNING when the pause is only unanswerable here (BST-558)', () => {
    // `getMatchingFailedKind` resolves tool.started ONLY on tool.failed. The
    // unanswerable-pause rejection must not close it out: the tool is genuinely
    // still suspended server-side, exactly as `runStillSuspended: true` says.
    const started = {
      id: 't1',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-future', toolName: 'brainstrike.someFutureSuspendingTool' },
      runId: 'run-1',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const rejected = {
      id: 't2',
      kind: UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
      label: 'Tool pause cannot be answered by this build',
      metadata: { toolCallId: 'call-future', toolName: 'brainstrike.someFutureSuspendingTool' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [
      { parts: [runEventPart(started), runEventPart(rejected)], role: 'assistant' },
    ];
    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('running');
  });

  it.each([
    ['subagent.finished', 'completed'],
    ['subagent.failed', 'failed'],
  ])('resolves subagent.started from its own %s terminal', (terminalKind, expected) => {
    // These rows are hidden from the timeline today (they render inside the
    // SubagentExecutionCard), so this pins the pairing itself rather than a
    // visible change: before the fix `subagent.started` paired with the
    // undeclared `subagent.completed` and could only resolve at end of run.
    const started = {
      id: 'sa1',
      kind: 'subagent.started',
      label: 'Subagent started',
      metadata: { parentToolCallId: 'delegation-1', personaId: 'explore' },
      runId: 'run-1',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const terminal = {
      id: 'sa2',
      kind: terminalKind,
      label: 'Subagent terminal',
      metadata: { parentToolCallId: 'delegation-1', personaId: 'explore' },
      runId: 'run-1',
      status: expected,
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    // `run.finished` last: reaching it instead of the subagent terminal is the
    // exact fallback the broken pairing was silently relying on.
    const runFinished = {
      id: 'sa3',
      kind: 'run.finished',
      label: 'Done',
      runId: 'run-1',
      status: 'completed',
      timestamp: '2026-06-05T00:00:02.000Z',
    };
    const messages = [
      {
        parts: [runEventPart(started), runEventPart(terminal), runEventPart(runFinished)],
        role: 'assistant',
      },
    ];

    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe(expected);
    expect(deriveAssistantRunEventRows(messages).statuses[started.id]).toBe(expected);
    // Unchanged either way: subagent rows never render in the main timeline.
    expect(resolveAssistantRunEventRenderPlan(messages, started).hidden).toBe(true);
    expect(deriveAssistantRunEventRows(messages).renderPlanKeys[started.id]).toBe('hidden');
  });

  it('never lets one delegation terminal close another delegation row', () => {
    // MAX_CONCURRENT_DELEGATIONS is 2, so two `subagent.started` rows are open
    // at once in one run. Subagent lifecycle events carry `parentToolCallId`
    // and NO `toolCallId` of their own, so the pairing must scope on
    // `parentToolCallId`. Delegation B's terminal deliberately lands FIRST:
    // unscoped, it would close A's row too and report B's outcome on it.
    const startedA = {
      id: 'a1',
      kind: 'subagent.started',
      label: 'Subagent started',
      metadata: { parentToolCallId: 'delegation-a', personaId: 'explore' },
      runId: 'run-1',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const startedB = { ...startedA, id: 'b1' };
    startedB.metadata = { parentToolCallId: 'delegation-b', personaId: 'plan' };
    const finishedB = {
      id: 'b2',
      kind: 'subagent.finished',
      label: 'Subagent completed',
      metadata: { parentToolCallId: 'delegation-b', personaId: 'plan' },
      runId: 'run-1',
      status: 'completed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const failedA = {
      id: 'a2',
      kind: 'subagent.failed',
      label: 'Subagent failed',
      metadata: { parentToolCallId: 'delegation-a', personaId: 'explore' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:02.000Z',
    };
    const messages = [
      {
        parts: [startedA, startedB, finishedB, failedA].map(runEventPart),
        role: 'assistant',
      },
    ];
    const rows = deriveAssistantRunEventRows(messages);

    expect(resolveAssistantRunEventStatus(messages, startedA as never)).toBe('failed');
    expect(resolveAssistantRunEventStatus(messages, startedB as never)).toBe('completed');
    expect(rows.statuses[startedA.id]).toBe('failed');
    expect(rows.statuses[startedB.id]).toBe('completed');
  });

  it('scopes nested subagent.tool rows by their own child toolCallId', () => {
    // Same hazard one level down: two child tool calls inside ONE delegation,
    // scoped by the child `toolCallId` that mapDelegationToolOutput puts on
    // both the started and terminal chunks.
    const parent = { parentToolCallId: 'delegation-a', personaId: 'explore' };
    const startedOne = {
      id: 'c1',
      kind: 'subagent.tool.started',
      label: 'Subagent tool started',
      metadata: { ...parent, toolCallId: 'child-1' },
      runId: 'run-1',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const startedTwo = {
      ...startedOne,
      id: 'c2',
      metadata: { ...parent, toolCallId: 'child-2' },
    };
    const failedTwo = {
      id: 'c3',
      kind: 'subagent.tool.failed',
      label: 'Subagent tool failed',
      metadata: { ...parent, toolCallId: 'child-2' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const completedOne = {
      id: 'c4',
      kind: 'subagent.tool.completed',
      label: 'Subagent tool completed',
      metadata: { ...parent, toolCallId: 'child-1' },
      runId: 'run-1',
      status: 'completed',
      timestamp: '2026-06-05T00:00:02.000Z',
    };
    const messages = [
      {
        parts: [startedOne, startedTwo, failedTwo, completedOne].map(runEventPart),
        role: 'assistant',
      },
    ];
    const rows = deriveAssistantRunEventRows(messages);

    expect(resolveAssistantRunEventStatus(messages, startedOne as never)).toBe('completed');
    expect(resolveAssistantRunEventStatus(messages, startedTwo as never)).toBe('failed');
    expect(rows.statuses[startedOne.id]).toBe('completed');
    expect(rows.statuses[startedTwo.id]).toBe('failed');
  });

  it('preserves the CANCELLED status of an aborted delegation terminal', () => {
    // TWO producers emit `subagent.failed` carrying status 'cancelled', and
    // neither means a hard failure:
    //   - `makeCancelledDelegationRunEventChunks` — every delegation still in
    //     flight when the parent run aborts;
    //   - `makeSubagentLifecycleChunk`'s `tool-output-denied` leg (BST-1282) —
    //     the user declined the delegation at its approval gate. Its comment
    //     is explicit: "'cancelled', not 'failed': nothing broke, the user
    //     chose."
    // Resolution takes the terminal's OWN status, so both stay 'cancelled'.
    // No `run.cancelled` in this fixture on purpose: the subagent terminal
    // alone must carry it.
    const started = {
      id: 'x1',
      kind: 'subagent.started',
      label: 'Subagent started',
      metadata: { parentToolCallId: 'delegation-a', personaId: 'explore' },
      runId: 'run-1',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const cancelled = {
      id: 'x2',
      kind: 'subagent.failed',
      label: 'Subagent cancelled',
      metadata: { parentToolCallId: 'delegation-a', personaId: 'explore' },
      runId: 'run-1',
      status: 'cancelled',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [{ parts: [started, cancelled].map(runEventPart), role: 'assistant' }];

    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('cancelled');
    expect(deriveAssistantRunEventRows(messages).statuses[started.id]).toBe('cancelled');
  });
});

describe('resolveAssistantRunEventRenderPlan', () => {
  const ts = '2026-06-11T00:00:00.000Z';

  it('hides tool.* events when their tool-call part renders as a card', () => {
    const started = {
      id: 't1',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-1', toolName: 'brainstrike.grepSearch' },
      status: 'running',
      timestamp: ts,
    };
    const messages = [
      {
        parts: [
          { toolCallId: 'call-1', toolName: 'brainstrike.grepSearch', type: 'tool-call' },
          runEventPart(started),
        ],
        role: 'assistant',
      },
    ];
    expect(resolveAssistantRunEventRenderPlan(messages, started).hidden).toBe(true);
  });

  it('hides subagent.* events from the timeline (they render inside the SubagentCard)', () => {
    for (const kind of [
      'subagent.started',
      'subagent.tool.started',
      'subagent.tool.completed',
      'subagent.finished',
    ]) {
      const event = {
        id: `s-${kind}`,
        kind,
        label: 'Subagent',
        metadata: { parentToolCallId: 'delegation-1', personaId: 'explore' },
        status: 'running',
        timestamp: ts,
      };
      const messages = [{ parts: [runEventPart(event)], role: 'assistant' }];
      expect(resolveAssistantRunEventRenderPlan(messages, event).hidden).toBe(true);
    }
  });

  it('keeps tool.* events visible when no matching tool-call part exists', () => {
    const started = {
      id: 't1',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-9', toolName: 'brainstrike.grepSearch' },
      status: 'running',
      timestamp: ts,
    };
    const messages = [{ parts: [runEventPart(started)], role: 'assistant' }];
    expect(resolveAssistantRunEventRenderPlan(messages, started)).toEqual({
      hidden: false,
      repeatCount: 1,
    });
  });

  it('hides a started row once its terminal row exists, but not while running', () => {
    const started = {
      id: 's1',
      kind: 'memory.observation.started',
      label: 'Observation started',
      status: 'running',
      timestamp: ts,
    };
    const runningMessages = [{ parts: [runEventPart(started)], role: 'assistant' }];
    expect(resolveAssistantRunEventRenderPlan(runningMessages, started).hidden).toBe(false);

    const completed = {
      id: 's2',
      kind: 'memory.observation.completed',
      label: 'Observation completed',
      status: 'completed',
      timestamp: ts,
    };
    const finishedMessages = [
      { parts: [runEventPart(started), runEventPart(completed)], role: 'assistant' },
    ];
    expect(resolveAssistantRunEventRenderPlan(finishedMessages, started).hidden).toBe(true);
    expect(resolveAssistantRunEventRenderPlan(finishedMessages, completed).hidden).toBe(false);
  });

  it('collapses consecutive identical rows into the first with a repeat count', () => {
    const first = {
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Observational memory read',
      status: 'info',
      timestamp: ts,
    };
    const second = { ...first, id: 'm2' };
    const third = { ...first, id: 'm3' };
    const messages = [
      {
        parts: [runEventPart(first), runEventPart(second), runEventPart(third)],
        role: 'assistant',
      },
    ];
    expect(resolveAssistantRunEventRenderPlan(messages, first)).toEqual({
      hidden: false,
      repeatCount: 3,
    });
    expect(resolveAssistantRunEventRenderPlan(messages, second).hidden).toBe(true);
    expect(resolveAssistantRunEventRenderPlan(messages, third).hidden).toBe(true);
  });

  it('does not collapse rows with different details', () => {
    const first = {
      detail: '3 notes',
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Observational memory read',
      status: 'info',
      timestamp: ts,
    };
    const second = { ...first, detail: '5 notes', id: 'm2' };
    const messages = [{ parts: [runEventPart(first), runEventPart(second)], role: 'assistant' }];
    expect(resolveAssistantRunEventRenderPlan(messages, first)).toEqual({
      hidden: false,
      repeatCount: 1,
    });
    expect(resolveAssistantRunEventRenderPlan(messages, second).hidden).toBe(false);
  });
});

describe('AssistantRunTimeline render', () => {
  it('renders a ×n repeat badge when repeatCount is above one', () => {
    render(
      <TooltipProvider>
        <AssistantRunTimeline
          data={{
            id: 'm1',
            kind: 'memory.working.loaded',
            label: 'Observational memory read',
            status: 'info',
            timestamp: '2026-06-11T00:00:00.000Z',
          }}
          repeatCount={2}
        />
      </TooltipProvider>
    );
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByTitle('Repeated 2 times')).toBeInTheDocument();
  });

  it('tints a memory event, omits the standalone status pill, and hides kind until expanded', () => {
    renderTimeline({
      detail: 'Loaded 3 notes',
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Working memory loaded',
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
    });
    const card = screen.getByTestId('assistant-run-timeline');
    expect(card.getAttribute('data-tool-category')).toBe('memory');
    expect(screen.queryByText('Completed')).toBeNull(); // no visible pill text
    expect(screen.queryByText('memory.working.loaded')).toBeNull(); // kind only in fold
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('memory.working.loaded')).toBeInTheDocument();
  });

  it('classifies a tool run event by its tool metadata', () => {
    renderTimeline({
      id: 't1',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolName: 'brainstrike.queryEmbeddingSpace' },
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
    });
    expect(screen.getByTestId('assistant-run-timeline').getAttribute('data-tool-category')).toBe(
      'internal'
    );
  });

  it('renders running run activity with the shared thinking indicator', () => {
    renderTimeline({
      id: 'r1',
      kind: 'run.step.started',
      label: 'Generating response',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    });

    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByLabelText('Running').querySelector('.lucide-circle-dashed')).not.toBeNull();
    expect(screen.getByTestId('assistant-thinking-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-tone', 'greyscale');
    expect(screen.getAllByTestId('assistant-thinking-mark')).toHaveLength(1);
  });
});

describe('tool.approval.requested resolution (BST-1402)', () => {
  const approval = (toolCallId: string, timestamp: string) => ({
    id: `approval-${toolCallId}`,
    kind: 'tool.approval.requested',
    label: 'Awaiting your approval',
    metadata: { toolCallId, toolName: 'brainstrike.executeCommand' },
    runId: 'run-1',
    status: 'running',
    timestamp,
  });
  const toolEvent = (kind: string, toolCallId: string, status: string, timestamp: string) => ({
    id: `${kind}-${toolCallId}`,
    kind,
    label: kind,
    metadata: { toolCallId, toolName: 'brainstrike.executeCommand' },
    runId: 'run-1',
    status,
    timestamp,
  });

  // The pause has no suffix-derived terminal on purpose (it is not a `.started`
  // kind), so without an explicit pairing its `running` row would spin forever —
  // the exact hazard `run-event terminal pairing contract` guards for `.started`
  // kinds. These pin the explicit pairing instead.
  it.each([
    ['tool.completed', 'completed', 'approve => the resumed stream runs the tool'],
    ['tool.failed', 'failed', 'decline => "Tool call declined"'],
    ['tool.resume.unsupported', 'failed', 'no resume UI in this build'],
  ])('closes the pause out on %s (%s)', (terminalKind, expected) => {
    const pause = approval('call-1', '2026-06-20T00:00:00.000Z');
    const terminal = toolEvent(terminalKind, 'call-1', expected, '2026-06-20T00:00:05.000Z');
    const messages = [{ parts: [runEventPart(pause), runEventPart(terminal)], role: 'assistant' }];
    expect(resolveAssistantRunEventStatus(messages, pause as never)).toBe(expected);
    expect(deriveAssistantRunEventRows(messages).statuses[pause.id]).toBe(expected);
  });

  it('is NOT closed out by the tool.started the approval merely unblocks', () => {
    // `tool.started` carries status 'running', so pairing against it would
    // "resolve" the row to the status it already had — and would report a
    // still-executing tool as an answered pause.
    const pause = approval('call-1', '2026-06-20T00:00:00.000Z');
    const started = toolEvent('tool.started', 'call-1', 'running', '2026-06-20T00:00:05.000Z');
    const messages = [{ parts: [runEventPart(pause), runEventPart(started)], role: 'assistant' }];
    expect(resolveAssistantRunEventStatus(messages, pause as never)).toBe('running');
    expect(deriveAssistantRunEventRows(messages).statuses[pause.id]).toBe('running');
  });

  it("never lets ANOTHER call's terminal answer this pause", () => {
    const pause = approval('call-1', '2026-06-20T00:00:00.000Z');
    const other = toolEvent('tool.completed', 'call-2', 'completed', '2026-06-20T00:00:05.000Z');
    const messages = [{ parts: [runEventPart(pause), runEventPart(other)], role: 'assistant' }];
    expect(resolveAssistantRunEventStatus(messages, pause as never)).toBe('running');
    expect(deriveAssistantRunEventRows(messages).statuses[pause.id]).toBe('running');
  });

  it('falls back to the run leaving running when the call never reports', () => {
    // Cancelling mid-pause produces no `tool.*` terminal at all.
    const pause = approval('call-1', '2026-06-20T00:00:00.000Z');
    const cancelled = {
      id: 'run-cancelled-1',
      kind: 'run.cancelled',
      label: 'Assistant run cancelled',
      runId: 'run-1',
      status: 'cancelled',
      timestamp: '2026-06-20T00:00:09.000Z',
    };
    const messages = [{ parts: [runEventPart(pause), runEventPart(cancelled)], role: 'assistant' }];
    expect(resolveAssistantRunEventStatus(messages, pause as never)).toBe('cancelled');
    expect(deriveAssistantRunEventRows(messages).statuses[pause.id]).toBe('cancelled');
  });

  it("stays visible on BOTH render-plan paths despite the paused call's card", () => {
    const pause = approval('call-1', '2026-06-20T00:00:00.000Z');
    const messages = [
      {
        parts: [
          runEventPart(pause),
          { toolCallId: 'call-1', toolName: 'brainstrike.executeCommand', type: 'tool-call' },
        ],
        role: 'assistant',
      },
    ];
    expect(resolveAssistantRunEventRenderPlan(messages, pause).hidden).toBe(false);
    expect(deriveAssistantRunEventRows(messages).renderPlanKeys[pause.id]).toBe('visible:1');
  });

  it('renders the pause label', () => {
    renderTimeline(approval('call-1', '2026-06-20T00:00:00.000Z'));
    expect(screen.getByText('Awaiting your approval')).toBeTruthy();
  });
});
