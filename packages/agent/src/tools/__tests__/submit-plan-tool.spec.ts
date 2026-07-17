import { describe, expect, it, vi } from 'vitest';
import { createSubmitPlanTool, SUBMIT_PLAN_TOOL_ID } from '../submit-plan-tool';

const INPUT = {
  overview: 'Do the thing safely.',
  steps: [{ title: 'Step one' }, { detail: 'carefully', title: 'Step two' }],
  title: 'My plan',
};

function runExecute(
  tool: ReturnType<typeof createSubmitPlanTool>,
  input: unknown,
  context: unknown
) {
  const execute = tool.execute as (i: unknown, c: unknown) => Promise<unknown>;
  return execute(input, context);
}

describe('submitPlan tool', () => {
  it('has the canonical id + suspend/resume schemas', () => {
    const tool = createSubmitPlanTool();
    expect(tool.id).toBe(SUBMIT_PLAN_TOOL_ID);
    expect(tool.suspendSchema).toBeDefined();
    expect(tool.resumeSchema).toBeDefined();
  });

  it('calls suspend once with the mapped plan payload when there is no resumeData', async () => {
    const tool = createSubmitPlanTool();
    const suspend = vi.fn(() => Promise.resolve());
    await runExecute(tool, INPUT, { agent: { suspend } });
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.calls[0]?.[0]).toEqual({
      overview: 'Do the thing safely.',
      steps: [{ title: 'Step one' }, { detail: 'carefully', title: 'Step two' }],
      title: 'My plan',
    });
  });

  it('returns approved status on resumeData action approved', async () => {
    const tool = createSubmitPlanTool();
    const result = await runExecute(tool, INPUT, {
      agent: { resumeData: { action: 'approved' } },
    });
    expect(result).toEqual({ status: 'approved' });
  });

  it('returns rejected status WITH feedback on resumeData rejected', async () => {
    const tool = createSubmitPlanTool();
    const result = await runExecute(tool, INPUT, {
      agent: { resumeData: { action: 'rejected', feedback: 'tighten step 2' } },
    });
    expect(result).toEqual({ feedback: 'tighten step 2', status: 'rejected' });
  });

  it('returns a readable status without throwing when there is no agent context', async () => {
    const tool = createSubmitPlanTool();
    const result = (await runExecute(tool, INPUT, {})) as { status: string; feedback?: string };
    expect(result.status).toBe('rejected');
    expect(result.feedback).toContain('My plan');
  });
});
