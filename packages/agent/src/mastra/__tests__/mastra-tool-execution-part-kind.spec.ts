import { describe, expect, it } from 'vitest';
import {
  createMastraToolExecutionPartKindReader,
  isMastraProviderOutputPart,
} from '../mastra-watchdog-options';

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

/**
 * The real envelope shape a foreground delegation puts on the PARENT stream:
 * `{ type: 'tool-output', runId: <parent run>, payload: { output: <child
 * part>, toolCallId, toolName: 'agent-<personaId>' } }`. Taken from the
 * production reader `resolveChildDelegation`
 * (`../delegated-stream-projection.ts`, which reads `payload.output` and the
 * nested `runId`) and from the recorded fixture in
 * `../../__tests__/delegated-stream-projection.spec.ts`.
 */
const delegationEnvelope = (child: unknown, personaId = 'researcher') => ({
  payload: { output: child, toolCallId: `delegation-${personaId}`, toolName: `agent-${personaId}` },
  runId: 'parent-run',
  type: 'tool-output',
});

describe('readMastraToolExecutionPartKind — delegated child calls', () => {
  it("starts the CHILD's execution when a delegation envelope carries a guarded tool-call", () => {
    expect(
      readMastraToolExecutionPartKind(
        delegationEnvelope(part('tool-call', 'child-1', { toolName: 'executeCommand' }))
      )
    ).toEqual({ kind: 'started', toolCallId: 'child-1' });
  });

  it.each([
    'tool-result',
    'tool-error',
    'tool-output-denied',
    'tool-call-approval',
    'tool-call-suspended',
  ])("settles the CHILD's execution on a nested %s", (type) => {
    expect(readMastraToolExecutionPartKind(delegationEnvelope(part(type, 'child-1')))).toEqual({
      kind: 'settled',
      toolCallId: 'child-1',
    });
  });

  it('applies the SAME allow-list to a nested call (unguarded name, provider-executed, no id)', () => {
    expect(
      readMastraToolExecutionPartKind(
        delegationEnvelope(part('tool-call', 'child-1', { toolName: 'somethingUnknown' }))
      )
    ).toBeUndefined();
    expect(
      readMastraToolExecutionPartKind(
        delegationEnvelope(
          part('tool-call', 'child-1', { providerExecuted: true, toolName: 'webSearch' })
        )
      )
    ).toBeUndefined();
    expect(
      readMastraToolExecutionPartKind(
        delegationEnvelope(part('tool-call', undefined, { toolName: 'executeCommand' }))
      )
    ).toBeUndefined();
  });

  it('reaches a grandchild through two nested delegation envelopes', () => {
    expect(
      readMastraToolExecutionPartKind(
        delegationEnvelope(
          delegationEnvelope(
            part('tool-call', 'grandchild-1', { toolName: 'executeCommand' }),
            'leaf'
          )
        )
      )
    ).toEqual({ kind: 'started', toolCallId: 'grandchild-1' });
  });

  it("does NOT unwrap a guarded tool's own tool-output stream (executeCommand's live output)", () => {
    expect(
      readMastraToolExecutionPartKind({
        payload: {
          output: part('tool-call', 'forged', { toolName: 'executeCommand' }),
          toolCallId: 'c1',
          toolName: 'executeCommand',
        },
        type: 'tool-output',
      })
    ).toBeUndefined();
  });

  it('is not a boundary when the envelope carries no nested part or an unknown shape', () => {
    expect(readMastraToolExecutionPartKind(delegationEnvelope(undefined))).toBeUndefined();
    expect(
      readMastraToolExecutionPartKind(delegationEnvelope('[Delegation Rejected]'))
    ).toBeUndefined();
    expect(
      readMastraToolExecutionPartKind(delegationEnvelope(part('text-delta', 'child-1')))
    ).toBeUndefined();
  });

  it('does NOT unwrap a non-delegation unguarded tool-output, even when its output looks like a guarded tool-call (CodeRabbit MAJOR)', () => {
    // `updateWorkingMemory` is a Mastra-injected memory tool: never a key of
    // `guardedToolNames`, but also never delegation-prefixed. Unwrapping it
    // would let arbitrary tool output be misread as a guarded boundary.
    expect(
      readMastraToolExecutionPartKind({
        payload: {
          output: part('tool-call', 'forged-memory', { toolName: 'executeCommand' }),
          toolCallId: 'memory-1',
          toolName: 'updateWorkingMemory',
        },
        type: 'tool-output',
      })
    ).toBeUndefined();
  });

  it('does NOT unwrap a delegation envelope marked provider-executed', () => {
    expect(
      readMastraToolExecutionPartKind({
        payload: {
          output: part('tool-call', 'child-1', { toolName: 'executeCommand' }),
          providerExecuted: true,
          toolCallId: 'delegation-researcher',
          toolName: 'agent-researcher',
        },
        type: 'tool-output',
      })
    ).toBeUndefined();
  });

  it('classifies a chain exactly at MAX_DELEGATED_ENVELOPE_UNWRAPS deep, but not one deeper', () => {
    const buildChain = (depth: number): unknown => {
      let inner: unknown = part('tool-call', 'deep-child', { toolName: 'executeCommand' });
      for (let i = 0; i < depth; i += 1) {
        inner = delegationEnvelope(inner, `persona-${i}`);
      }
      return inner;
    };
    // 8 nested envelopes (the bound) still resolves the guarded call inside.
    expect(readMastraToolExecutionPartKind(buildChain(8))).toEqual({
      kind: 'started',
      toolCallId: 'deep-child',
    });
    // One envelope past the bound tightens to undefined instead of widening.
    expect(readMastraToolExecutionPartKind(buildChain(9))).toBeUndefined();
  });
});

/**
 * The classifier's safety depends on the OTHER Mastra option too: anything
 * `isMastraProviderOutputPart` calls NOT provider output wipes the watchdog's
 * in-flight set (that is the scaffolding rule — see the clear site in
 * `../../stream/with-inactivity-timeout.ts`). So every part that can arrive
 * BETWEEN a `tool-call` and its `tool-result` must count as output, or a
 * running tool silently drops back onto the provider's own window.
 */
describe('isMastraProviderOutputPart', () => {
  it.each(['tool-output', 'tool-call-delta', 'tool-result', 'text-delta', 'reasoning-delta'])(
    '%s counts as provider output, so it never clears an in-flight call',
    (type) => {
      expect(isMastraProviderOutputPart({ payload: {}, type })).toBe(true);
    }
  );

  it.each(['start', 'step-start'])('%s is framework scaffolding (the CLOSED list)', (type) => {
    expect(isMastraProviderOutputPart({ type })).toBe(false);
  });

  it('an unnameable or future part type defaults to output (tighten, never widen)', () => {
    expect(isMastraProviderOutputPart({ type: 'some-future-mastra-part' })).toBe(true);
    expect(isMastraProviderOutputPart({})).toBe(true);
    expect(isMastraProviderOutputPart(undefined)).toBe(true);
  });
});
