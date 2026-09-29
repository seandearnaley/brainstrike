import { describe, expect, it } from 'vitest';
import { getToolActionTarget, isMatchingToolAction } from '../delegated-tool-actions';
import { isAssistantToolApprovalAction } from '../tool-approval';
import { isAssistantToolResumeAction } from '../tool-suspend';

describe('exact child continuation decisions', () => {
  const target = { continuationId: 'followup-1', runId: 'new-native-run', toolCallId: 'leaf' };
  it('retains the continuation on the ordinary shared approval and question transport', () => {
    expect(isAssistantToolApprovalAction({ ...target, action: 'approve' })).toBe(true);
    expect(isAssistantToolResumeAction({ ...target, resumeData: { answer: 'yes' } })).toBe(true);
    expect(getToolActionTarget(target)).toEqual(target);
    expect(isMatchingToolAction({ ...target, action: 'approve' }, target)).toBe(true);
    expect(isMatchingToolAction({ ...target, continuationId: 'other' }, target)).toBe(false);
  });
  it('keeps the continuation anchor with an observed descendant path', () => {
    const nested = {
      continuationId: target.continuationId,
      delegation: {
        path: [
          {
            childRuntimeRunId: 'nested-native',
            parentRuntimeRunId: target.runId,
            parentToolCallId: 'delegate-child',
            personaId: 'explore',
          },
        ],
        toolCallId: 'nested-leaf',
      },
      runId: target.runId,
      toolCallId: 'delegate-child',
    };
    expect(isAssistantToolApprovalAction({ ...nested, action: 'approve' })).toBe(true);
    expect(getToolActionTarget(nested)).toEqual(nested);
    expect(isMatchingToolAction(nested, nested)).toBe(true);
    expect(isMatchingToolAction({ ...nested, continuationId: 'other' }, nested)).toBe(false);
  });
  it('rejects missing or inherited continuation identity', () => {
    expect(
      isAssistantToolApprovalAction({ ...target, action: 'approve', continuationId: '' })
    ).toBe(false);
    expect(
      isAssistantToolApprovalAction(
        Object.assign(Object.create({ continuationId: 'hidden' }), {
          action: 'approve',
          runId: 'run',
          toolCallId: 'call',
        })
      )
    ).toBe(false);
  });
});
