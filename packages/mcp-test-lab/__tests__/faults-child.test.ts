import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';

describe('MCP child fault declarations', () => {
  it('rejects malformed JSON at child spawn because the pinned reader skips it invisibly', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'malformed_json', payload: '{' },
          id: 'invisible-child-stdout',
          match: { method: 'child/spawn', occurrence: 1, phase: 'child-process' },
        },
      ])
    ).toThrow(/incompatible with coordinate child-process\/child\/spawn/i);
  });

  it('bounds child stderr bytes and rejects non-portable child signals', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'child_stderr', text: 'x'.repeat(4097) },
          id: 'oversized-child-stderr',
          match: { method: 'child/stderr', occurrence: 1, phase: 'child-process' },
        },
      ])
    ).toThrow(/child stderr text exceeds 4096 bytes/i);
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { code: null, kind: 'child_exit', signal: 'SIGABRT' },
          id: 'non-portable-signal',
          match: { method: 'child/exit', occurrence: 1, phase: 'child-process' },
        },
      ] as never)
    ).toThrow(/supported terminating signal/i);
  });
});
