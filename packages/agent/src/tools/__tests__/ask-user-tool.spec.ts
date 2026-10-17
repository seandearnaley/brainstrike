import { describe, expect, it } from 'vitest';
import {
  ASK_USER_TOOL_ID,
  createAskUserTool,
  formatAskUserAnswer,
  readAskUserResumeAnswer,
} from '../ask-user-tool';

describe('host-owned askUser declaration', () => {
  it('declares executable input and resume schemas without a second suspension owner', () => {
    const tool = createAskUserTool();
    expect(tool.id).toBe(ASK_USER_TOOL_ID);
    expect(tool.execute).toBeTypeOf('function');
    expect(tool).not.toHaveProperty('suspendSchema');
    expect(
      tool.inputSchema['~standard'].validate({ options: [{ label: 'A' }], question: 'Pick' })
    ).toHaveProperty('value');
    expect(tool.resumeSchema['~standard'].validate({ answer: ['A'] })).toHaveProperty('value');
    expect(tool.resumeSchema['~standard'].validate({ answer: 42 })).toHaveProperty('issues');
  });
  it('executes only the host-validated resumed answer', async () => {
    const tool = createAskUserTool();
    await expect(tool.execute({}, { resumeData: { answer: ['A', 'B'] } })).resolves.toEqual({
      answer: 'A, B',
    });
    await expect(tool.execute({ question: 'Not an answer' })).rejects.toThrow('resume payload');
  });
  it('formats valid answers and refuses drifted answers', () => {
    expect(formatAskUserAnswer('yes')).toBe('yes');
    expect(formatAskUserAnswer(['a', 'b'])).toBe('a, b');
    expect(readAskUserResumeAnswer({ answer: 'yes' })).toBe('yes');
    expect(() => readAskUserResumeAnswer({ approved: true })).toThrow(/matched neither/);
    expect(() => readAskUserResumeAnswer(42)).toThrow(/matched neither/);
    expect(() => readAskUserResumeAnswer(['a', 7])).toThrow(/matched neither/);
  });
});
