import { describe, expect, it } from 'vitest';
import { readMastraToolExecutionPartKind } from '../agent-streaming';

const part = (type: string, toolCallId?: unknown, extra?: Record<string, unknown>) => ({
  payload: { toolCallId, ...extra },
  type,
});

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

  it('a provider-executed tool-call has no guard behind it and is not a boundary', () => {
    expect(
      readMastraToolExecutionPartKind(
        part('tool-call', 'c1', { providerExecuted: true, toolName: 'webSearch' })
      )
    ).toBeUndefined();
  });

  it('a delegation-prefixed tool-call has no guard behind it and is not a boundary', () => {
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 'c1', { toolName: 'agent-researcher' }))
    ).toBeUndefined();
  });

  it('an ordinary (non-provider-executed) tool-call still starts an execution', () => {
    expect(
      readMastraToolExecutionPartKind(
        part('tool-call', 'c1', { providerExecuted: false, toolName: 'executeCommand' })
      )
    ).toEqual({ kind: 'started', toolCallId: 'c1' });
  });
});
