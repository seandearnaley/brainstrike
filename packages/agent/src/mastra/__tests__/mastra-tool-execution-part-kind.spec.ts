import { describe, expect, it } from 'vitest';
import { readMastraToolExecutionPartKind } from '../agent-streaming';

const part = (type: string, toolCallId?: unknown) => ({ payload: { toolCallId }, type });

describe('readMastraToolExecutionPartKind', () => {
  it('tool-call starts an execution', () => {
    expect(readMastraToolExecutionPartKind(part('tool-call', 'c1'))).toEqual({
      kind: 'started',
      toolCallId: 'c1',
    });
  });
  it.each([
    'tool-result',
    'tool-error',
    'tool-output-denied',
    'tool-call-approval',
    'tool-call-suspended',
  ])('%s settles it', (type) => {
    expect(readMastraToolExecutionPartKind(part(type, 'c1'))).toEqual({
      kind: 'settled',
      toolCallId: 'c1',
    });
  });
  it.each([
    'tool-output',
    'tool-call-delta',
    'tool-call-input-streaming-start',
    'text-delta',
    'step-start',
  ])('%s is not a boundary', (type) => {
    expect(readMastraToolExecutionPartKind(part(type, 'c1'))).toBeUndefined();
  });
  it('a boundary part without a string toolCallId is not a boundary (never invent an id)', () => {
    expect(readMastraToolExecutionPartKind(part('tool-call', undefined))).toBeUndefined();
    expect(readMastraToolExecutionPartKind(part('tool-call', 7))).toBeUndefined();
  });
});
