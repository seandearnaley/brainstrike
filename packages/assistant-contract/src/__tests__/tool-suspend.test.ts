import { describe, expect, it } from 'vitest';
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
