import { describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_TOOL_ID,
  createAskUserTool,
  formatAskUserAnswer,
  readAskUserResumeAnswer,
} from '../ask-user-tool';

function runExecute(tool: ReturnType<typeof createAskUserTool>, input: unknown, context: unknown) {
  const execute = tool.execute as (i: unknown, c: unknown) => Promise<unknown>;
  return execute(input, context);
}

describe('askUser tool', () => {
  it('has the canonical id + suspend/resume schemas', () => {
    const tool = createAskUserTool();
    expect(tool.id).toBe(ASK_USER_TOOL_ID);
    expect(tool.suspendSchema).toBeDefined();
    expect(tool.resumeSchema).toBeDefined();
  });

  it('formatAskUserAnswer joins arrays with commas', () => {
    expect(formatAskUserAnswer('yes')).toBe('yes');
    expect(formatAskUserAnswer(['a', 'b'])).toBe('a, b');
  });

  it('suspends with question only for a free-text question', async () => {
    const tool = createAskUserTool();
    const suspend = vi.fn((_payload: unknown) => Promise.resolve());
    await runExecute(tool, { question: 'What city?' }, { agent: { suspend } });
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.calls[0]?.[0]).toEqual({ question: 'What city?' });
  });

  it('defaults selectionMode to single_select when options are present', async () => {
    const tool = createAskUserTool();
    const suspend = vi.fn((_payload: unknown) => Promise.resolve());
    await runExecute(
      tool,
      { options: [{ label: 'A' }, { label: 'B' }], question: 'Pick' },
      { agent: { suspend } }
    );
    expect(suspend.mock.calls[0]?.[0]).toEqual({
      options: [{ label: 'A' }, { label: 'B' }],
      question: 'Pick',
      selectionMode: 'single_select',
    });
  });

  it('returns the answer on a free-text and multi-select {answer} envelope resume', async () => {
    const tool = createAskUserTool();
    const free = await runExecute(
      tool,
      { question: 'q' },
      { agent: { resumeData: { answer: 'San Francisco' } } }
    );
    expect(free).toEqual({ answer: 'San Francisco' });
    const multi = await runExecute(
      tool,
      { question: 'q' },
      { agent: { resumeData: { answer: ['a', 'b'] } } }
    );
    expect(multi).toEqual({ answer: 'a, b' });
  });

  it("ignores the transport's approved rider on an envelope resume", async () => {
    // Ask-gating askUser makes the suspend-resume transport attach
    // `approved: true` to the envelope; the tool reads only `answer`.
    const tool = createAskUserTool();
    const result = await runExecute(
      tool,
      { question: 'q' },
      { agent: { resumeData: { answer: 'yes', approved: true } } }
    );
    expect(result).toEqual({ answer: 'yes' });
  });

  it('LEGACY compat: still accepts a bare string / string[] resume from a pre-envelope suspended run', async () => {
    const tool = createAskUserTool();
    const free = await runExecute(
      tool,
      { question: 'q' },
      { agent: { resumeData: 'San Francisco' } }
    );
    expect(free).toEqual({ answer: 'San Francisco' });
    const multi = await runExecute(tool, { question: 'q' }, { agent: { resumeData: ['a', 'b'] } });
    expect(multi).toEqual({ answer: 'a, b' });
  });

  it('throws on a resume payload matching neither the envelope nor the legacy shape', () => {
    // Transport drift must never be mislabelled as a user answer.
    expect(() => readAskUserResumeAnswer({ approved: true })).toThrow(/matched neither/);
    expect(() => readAskUserResumeAnswer(42)).toThrow(/matched neither/);
    expect(() => readAskUserResumeAnswer(['a', 7])).toThrow(/matched neither/);
  });

  it('returns a readable answer without throwing when there is no agent context', async () => {
    const tool = createAskUserTool();
    const result = (await runExecute(tool, { question: 'Ready?' }, {})) as { answer: string };
    expect(result.answer).toContain('Ready?');
  });
});
