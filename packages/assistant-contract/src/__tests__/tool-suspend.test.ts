import { describe, expect, it } from 'vitest';
import { ASSISTANT_RUN_EVENT_KINDS } from '../run-events.js';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
} from '../tool-approval.js';
import {
  type AssistantToolResumeAction,
  hasRegisteredSuspendResumeUi,
  isAssistantToolResumeAction,
  isRediscoveredToolSuspend,
  REGISTERED_SUSPEND_RESUME_TOOL_IDS,
  readToolResumeRunConfigAction,
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
  UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
} from '../tool-suspend.js';

function runConfig(action: unknown): unknown {
  return { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } };
}

describe('unsupported-resume run event kind', () => {
  it('is a registered run-event kind (the read path throws on unknown kinds)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain(UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND);
  });

  it('is NOT a tool.* metric kind — it must not reach the ledger/duration pairings', () => {
    // `RUN_LEDGER_AGGREGATION_SQL` counts `tool.completed`/`tool.failed`;
    // `collectToolDurations` and `getMatchingFailedKind` pair `tool.started` with
    // those same two. A pause this build cannot answer is neither a tool call nor
    // a tool failure — and the run stays suspended, so a later build resuming it
    // emits the real `tool.completed` for the SAME toolCallId.
    expect(UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND).not.toBe('tool.failed');
    expect(UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND).not.toBe('tool.completed');
    expect(UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND).toBe('tool.resume.unsupported');
  });
});

describe('tool-suspend contract', () => {
  it('exposes stable transport names', () => {
    expect(TOOL_SUSPEND_DATA_NAME).toBe('brainstrike.tool-suspend');
    expect(TOOL_SUSPEND_RUN_CONFIG_KEY).toBe('brainstrikeToolSuspend');
  });

  it('returns undefined when no suspend action is present', () => {
    expect(readToolResumeRunConfigAction(undefined)).toBeUndefined();
    expect(readToolResumeRunConfigAction({})).toBeUndefined();
    expect(readToolResumeRunConfigAction({ custom: {} })).toBeUndefined();
  });

  it('reads a valid resume action with an object resumeData', () => {
    const action = { resumeData: { action: 'approved' }, runId: 'r', toolCallId: 't' };
    expect(readToolResumeRunConfigAction(runConfig(action))).toEqual({ action });
  });

  it('accepts arbitrary resumeData shapes (string and string[])', () => {
    const free: AssistantToolResumeAction = {
      resumeData: 'free text',
      runId: 'r',
      toolCallId: 't',
    };
    const multi: AssistantToolResumeAction = {
      resumeData: ['a', 'b'],
      runId: 'r',
      toolCallId: 't',
    };
    expect(readToolResumeRunConfigAction(runConfig(free))).toEqual({ action: free });
    expect(readToolResumeRunConfigAction(runConfig(multi))).toEqual({ action: multi });
  });

  it('accepts resumeData: null (present key, any value)', () => {
    const action = { resumeData: null, runId: 'r', toolCallId: 't' };
    expect(readToolResumeRunConfigAction(runConfig(action))).toEqual({ action });
  });

  it('marks malformed actions invalid instead of coercing', () => {
    expect(readToolResumeRunConfigAction(runConfig({ resumeData: 'x', toolCallId: 't' }))).toEqual({
      invalid: true,
    });
    expect(
      readToolResumeRunConfigAction(runConfig({ resumeData: 1, runId: '  ', toolCallId: 't' }))
    ).toEqual({ invalid: true });
    expect(
      readToolResumeRunConfigAction(runConfig({ resumeData: 1, runId: 'r', toolCallId: '' }))
    ).toEqual({ invalid: true });
    // Missing the resumeData KEY entirely is malformed (a resume with no answer).
    expect(readToolResumeRunConfigAction(runConfig({ runId: 'r', toolCallId: 't' }))).toEqual({
      invalid: true,
    });
  });

  it('rejects resume actions with extra own fields', () => {
    const action = {
      injected: true,
      resumeData: 'answer',
      runId: 'r',
      toolCallId: 't',
    };

    expect(isAssistantToolResumeAction(action)).toBe(false);
    expect(readToolResumeRunConfigAction(runConfig(action))).toEqual({ invalid: true });
  });

  it('rejects resume actions with extra own symbol fields', () => {
    const action = {
      resumeData: 'answer',
      runId: 'r',
      toolCallId: 't',
      [Symbol('injected')]: true,
    };

    expect(isAssistantToolResumeAction(action)).toBe(false);
  });

  it.each(['resumeData', 'runId', 'toolCallId'] as const)(
    'rejects an inherited %s field',
    (field) => {
      const inheritedValue = field === 'resumeData' ? 'answer' : field;
      const action = Object.assign(Object.create({ [field]: inheritedValue }) as object, {
        ...(field === 'resumeData' ? {} : { resumeData: 'answer' }),
        ...(field === 'runId' ? {} : { runId: 'r' }),
        ...(field === 'toolCallId' ? {} : { toolCallId: 't' }),
      });

      expect(isAssistantToolResumeAction(action)).toBe(false);
    }
  );

  it('rejects an inherited optional toolName', () => {
    const action = Object.assign(Object.create({ toolName: 'askUser' }) as object, {
      resumeData: 'answer',
      runId: 'r',
      toolCallId: 't',
    });

    expect(isAssistantToolResumeAction(action)).toBe(false);
  });

  it.each([
    ['own undefined', { resumeData: 'answer', runId: 'r', toolCallId: 't', toolName: undefined }],
    [
      'inherited undefined',
      Object.assign(Object.create({ toolName: undefined }) as object, {
        resumeData: 'answer',
        runId: 'r',
        toolCallId: 't',
      }),
    ],
  ])('rejects an %s optional toolName', (_caseName, action) => {
    expect(isAssistantToolResumeAction(action)).toBe(false);
  });

  it('accepts identifiers exactly at the shared tool-action limits', () => {
    expect(
      isAssistantToolResumeAction({
        resumeData: 'answer',
        runId: 'r'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS),
        toolCallId: 'c'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS),
        toolName: 't'.repeat(ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS),
      })
    ).toBe(true);
  });

  it.each([
    ['runId', ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS],
    ['toolCallId', ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS],
    ['toolName', ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS],
  ] as const)('rejects an oversized %s', (field, maxChars) => {
    expect(
      isAssistantToolResumeAction({
        resumeData: 'answer',
        runId: 'r',
        toolCallId: 't',
        toolName: 'askUser',
        [field]: 'x'.repeat(maxChars + 1),
      })
    ).toBe(false);
  });

  it('rejects a blank optional tool name', () => {
    expect(
      isAssistantToolResumeAction({
        resumeData: 'answer',
        runId: 'r',
        toolCallId: 't',
        toolName: '   ',
      })
    ).toBe(false);
  });

  it('isAssistantToolResumeAction rejects non-records and bad shapes', () => {
    expect(isAssistantToolResumeAction(null)).toBe(false);
    expect(isAssistantToolResumeAction(['r', 't'])).toBe(false);
    expect(isAssistantToolResumeAction({ runId: 'r', toolCallId: 't' })).toBe(false);
    expect(isAssistantToolResumeAction({ resumeData: 1, toolCallId: 't' })).toBe(false);
    expect(
      isAssistantToolResumeAction({ resumeData: 1, runId: 'r', toolCallId: 't', toolName: 5 })
    ).toBe(false);
    expect(isAssistantToolResumeAction({ resumeData: 'ok', runId: 'r', toolCallId: 't' })).toBe(
      true
    );
  });

  it('carries the host leg that surfaced the pause beside the native run id', () => {
    const action = {
      hostRunId: 'run-host-leg-1',
      resumeData: { answer: 'us-east-1' },
      runId: '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039',
      toolCallId: 't',
    };

    expect(isAssistantToolResumeAction(action)).toBe(true);
    expect(readToolResumeRunConfigAction(runConfig(action))).toEqual({ action });
  });

  it.each([
    ['blank', '   '],
    ['oversized', 'h'.repeat(ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS + 1)],
    ['non-string', 7],
    ['explicitly undefined', undefined],
  ])('rejects a %s hostRunId', (_caseName, hostRunId) => {
    expect(
      isAssistantToolResumeAction({ hostRunId, resumeData: 'answer', runId: 'r', toolCallId: 't' })
    ).toBe(false);
  });

  it('rejects an inherited hostRunId', () => {
    const action = Object.assign(Object.create({ hostRunId: 'run-host-leg-1' }) as object, {
      resumeData: 'answer',
      runId: 'r',
      toolCallId: 't',
    });

    expect(isAssistantToolResumeAction(action)).toBe(false);
  });
});

describe('isRediscoveredToolSuspend', () => {
  const base = {
    runId: 'run-suspend-1',
    stale: false,
    suspendedAt: '2026-08-01T10:00:00.000Z',
    suspendPayload: { question: 'Which file?' },
    toolCallId: 'call-suspend-1',
    toolName: 'brainstrike.askUser',
  };

  it('rejects a present unknown or unscoped durable decision state', () => {
    const request = {
      runId: 'root',
      stale: false,
      suspendedAt: '2026-09-10T00:00:00Z',
      toolCallId: 'parent-call',
      toolName: 'brainstrike.askUser',
    };
    const delegation = {
      path: [
        {
          childRuntimeRunId: 'child',
          parentRuntimeRunId: 'root',
          parentToolCallId: 'parent-call',
          personaId: 'worker',
        },
      ],
      toolCallId: 'leaf',
    };
    expect(
      isRediscoveredToolSuspend({ ...request, decisionState: 'interrupted', delegation })
    ).toBe(true);
    expect(isRediscoveredToolSuspend({ ...request, decisionState: 'unknown', delegation })).toBe(
      false
    );
    expect(isRediscoveredToolSuspend({ ...request, decisionState: 'claimed' })).toBe(false);
  });

  it('accepts a fully-formed rediscovered suspend, with or without optional fields', () => {
    expect(isRediscoveredToolSuspend(base)).toBe(true);
    const { suspendPayload: _payload, ...withoutPayload } = base;
    expect(isRediscoveredToolSuspend(withoutPayload)).toBe(true);
    expect(isRediscoveredToolSuspend({ ...base, resumeSupported: false, stale: true })).toBe(true);
  });

  it('rejects a missing base identifier or wrong-typed rediscovery fields', () => {
    const { runId: _runId, ...withoutRunId } = base;
    const { toolCallId: _toolCallId, ...withoutToolCallId } = base;
    const { toolName: _toolName, ...withoutToolName } = base;
    const { suspendedAt: _suspendedAt, ...withoutSuspendedAt } = base;
    const { stale: _stale, ...withoutStale } = base;
    expect(isRediscoveredToolSuspend(withoutRunId)).toBe(false);
    expect(isRediscoveredToolSuspend(withoutToolCallId)).toBe(false);
    expect(isRediscoveredToolSuspend(withoutToolName)).toBe(false);
    expect(isRediscoveredToolSuspend(withoutSuspendedAt)).toBe(false);
    expect(isRediscoveredToolSuspend(withoutStale)).toBe(false);
    expect(isRediscoveredToolSuspend({ ...base, suspendedAt: 123 })).toBe(false);
    expect(isRediscoveredToolSuspend({ ...base, stale: 'yes' })).toBe(false);
    expect(isRediscoveredToolSuspend({ ...base, runId: '' })).toBe(false);
  });

  it('keeps an otherwise-valid pause whatever resumeSupported holds — the flag is advisory', () => {
    // Rejecting a real pause over an unrecognized advisory value would
    // re-create the silent stranding this contract exists to remove: the
    // renderer dispatches on toolName, never on this field.
    expect(isRediscoveredToolSuspend({ ...base, resumeSupported: true })).toBe(true);
    expect(isRediscoveredToolSuspend({ ...base, resumeSupported: 'no' })).toBe(true);
  });

  it('rejects non-records', () => {
    expect(isRediscoveredToolSuspend(undefined)).toBe(false);
    expect(isRediscoveredToolSuspend(null)).toBe(false);
    expect(isRediscoveredToolSuspend([base])).toBe(false);
  });
});

describe('run_python Gate B registration (BST-1070)', () => {
  it('registers brainstrike.runPython as a suspending tool with a typed resume UI', () => {
    expect(hasRegisteredSuspendResumeUi('brainstrike.runPython')).toBe(true);
    expect(REGISTERED_SUSPEND_RESUME_TOOL_IDS).toContain('brainstrike.runPython');
  });
});
