import { describe, expect, it } from 'vitest';
import { createMastraToolExecutionPartKindReader } from '../agent-streaming';

const part = (type: string, toolCallId?: unknown, extra?: Record<string, unknown>) => ({
  payload: { toolCallId, ...extra },
  type,
});

const GUARDED_TOOL_NAMES = new Set(['executeCommand', 'webSearch']);
const readMastraToolExecutionPartKind = createMastraToolExecutionPartKindReader(GUARDED_TOOL_NAMES);

describe('readMastraToolExecutionPartKind', () => {
  it('tool-call starts an execution for a guarded tool name', () => {
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 'c1', { toolName: 'executeCommand' }))
    ).toEqual({
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
  ])('%s settles it regardless of tool name', (type) => {
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
    expect(
      readMastraToolExecutionPartKind(part(type, 'c1', { toolName: 'executeCommand' }))
    ).toBeUndefined();
  });
  it('a boundary part without a string toolCallId is not a boundary (never invent an id)', () => {
    expect(
      readMastraToolExecutionPartKind(part('tool-call', undefined, { toolName: 'executeCommand' }))
    ).toBeUndefined();
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 7, { toolName: 'executeCommand' }))
    ).toBeUndefined();
  });

  it('a guarded tool-call marked provider-executed has no guard behind it and is not a boundary', () => {
    expect(
      readMastraToolExecutionPartKind(
        part('tool-call', 'c1', { providerExecuted: true, toolName: 'webSearch' })
      )
    ).toBeUndefined();
  });

  it('a delegation-prefixed tool name (never in the guarded set) is not a boundary', () => {
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 'c1', { toolName: 'agent-researcher' }))
    ).toBeUndefined();
  });

  it('a Mastra-injected memory tool (never in the guarded set) is not a boundary', () => {
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 'c1', { toolName: 'updateWorkingMemory' }))
    ).toBeUndefined();
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 'c1', { toolName: 'recall' }))
    ).toBeUndefined();
  });

  it('an arbitrary unknown tool name (not in the guarded set) is not a boundary', () => {
    expect(
      readMastraToolExecutionPartKind(part('tool-call', 'c1', { toolName: 'somethingUnknown' }))
    ).toBeUndefined();
  });

  it('a guarded, non-provider-executed tool-call still starts an execution', () => {
    expect(
      readMastraToolExecutionPartKind(
        part('tool-call', 'c1', { providerExecuted: false, toolName: 'executeCommand' })
      )
    ).toEqual({ kind: 'started', toolCallId: 'c1' });
  });
});
