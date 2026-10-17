import { describe, expect, it } from 'vitest';
import { createSubmitPlanTool, SUBMIT_PLAN_TOOL_ID } from '../submit-plan-tool';

describe('host-owned submitPlan declaration', () => {
  it('declares the actual plan and decision contracts without a vendor suspension', () => {
    const tool = createSubmitPlanTool();
    expect(tool.id).toBe(SUBMIT_PLAN_TOOL_ID);
    expect(tool.execute).toBeTypeOf('function');
    expect(tool).not.toHaveProperty('suspendSchema');
    expect(
      tool.inputSchema['~standard'].validate({
        overview: 'Do it',
        steps: [{ title: 'Check' }],
        title: 'Plan',
      })
    ).toHaveProperty('value');
    expect(tool.inputSchema['~standard'].validate({ title: 'Incomplete' })).toHaveProperty(
      'issues'
    );
    expect(tool.resumeSchema['~standard'].validate({ action: 'approved' })).toHaveProperty('value');
    expect(
      tool.resumeSchema['~standard'].validate({ action: 'rejected', feedback: 'Tighten step two' })
    ).toHaveProperty('value');
    expect(tool.resumeSchema['~standard'].validate({ action: 'allow' })).toHaveProperty('issues');
  });
  it('executes only the host-validated decision, keeping rejection feedback', async () => {
    const tool = createSubmitPlanTool();
    await expect(tool.execute({}, { resumeData: { action: 'approved' } })).resolves.toEqual({
      status: 'approved',
    });
    await expect(
      tool.execute({}, { resumeData: { action: 'rejected', feedback: 'Revise step two' } })
    ).resolves.toEqual({ feedback: 'Revise step two', status: 'rejected' });
    await expect(tool.execute({})).rejects.toThrow('host-validated decision');
  });
});
