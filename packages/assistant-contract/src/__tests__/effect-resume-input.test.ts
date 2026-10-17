import { describe, expect, it } from 'vitest';
import {
  AskUserResumeSchema,
  SubmitPlanResumeSchema,
} from '../native-tools/schemas/schemas-tasks.js';
import { validateToolInputValue } from '../native-tools/schemas/tool-input-schema.js';

describe('ordinary resume envelopes', () => {
  it('strips unknown riders and keeps the plan decision', () => {
    expect(
      validateToolInputValue(SubmitPlanResumeSchema, {
        action: 'approved',
        approved: true,
        feedback: 'go',
        rider: 'ignored',
      })
    ).toEqual({ success: true, value: { action: 'approved', feedback: 'go' } });
    expect(
      validateToolInputValue(SubmitPlanResumeSchema, { action: 'rejected', rider: null })
    ).toEqual({ success: true, value: { action: 'rejected' } });
    expect(
      validateToolInputValue(SubmitPlanResumeSchema, { action: 'approved', feedback: null }).success
    ).toBe(false);
  });
  it('keeps question envelopes, strips unknown riders and accepts current bare arms', () => {
    expect(
      validateToolInputValue(AskUserResumeSchema, {
        answer: ['A', 'B'],
        approved: true,
        rider: 'ignored',
      })
    ).toEqual({ success: true, value: { answer: ['A', 'B'], approved: true } });
    expect(validateToolInputValue(AskUserResumeSchema, 'answer')).toEqual({
      success: true,
      value: 'answer',
    });
    expect(validateToolInputValue(AskUserResumeSchema, ['A', 'B'])).toEqual({
      success: true,
      value: ['A', 'B'],
    });
  });
  it('refuses malformed declared question fields without treating null as omission', () => {
    for (const input of [
      { approved: true },
      { answer: 'A', approved: false },
      { answer: 'A', approved: null },
      { answer: ['A', 1] },
      null,
    ]) {
      expect(validateToolInputValue(AskUserResumeSchema, input).success).toBe(false);
    }
  });
});
