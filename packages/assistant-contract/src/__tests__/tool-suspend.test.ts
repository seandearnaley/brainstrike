import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
} from '../tool-approval.js';
import {
  type AssistantToolResumeAction,
  isAssistantToolResumeAction,
  readToolResumeRunConfigAction,
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '../tool-suspend.js';

function runConfig(action: unknown): unknown {
  return { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: action } };
}

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

  it.each([
    'resumeData',
    'runId',
    'toolCallId',
  ] as const)('rejects an inherited %s field', (field) => {
    const inheritedValue = field === 'resumeData' ? 'answer' : field;
    const action = Object.assign(Object.create({ [field]: inheritedValue }) as object, {
      ...(field === 'resumeData' ? {} : { resumeData: 'answer' }),
      ...(field === 'runId' ? {} : { runId: 'r' }),
      ...(field === 'toolCallId' ? {} : { toolCallId: 't' }),
    });

    expect(isAssistantToolResumeAction(action)).toBe(false);
  });

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
});
