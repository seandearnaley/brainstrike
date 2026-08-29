import { describe, expect, it } from 'vitest';
import {
  createMcpLabFaultPlan,
  type McpLabFaultConsumption,
  type McpLabFaultDeclaration,
} from '../src/faults';

describe('MCP lab fault plan', () => {
  it.each([undefined, null, 42, '', '  '])('rejects invalid fault id %j', (id) => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'drop_response' },
          id,
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ] as never)
    ).toThrowError(/fault id.*non-empty string/i);
  });

  it.each([
    {
      extra: true,
      fault: { kind: 'drop_response' },
      id: 'extra-declaration-key',
      match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
    },
    {
      fault: { kind: 'drop_response' },
      id: 'extra-match-key',
      match: {
        method: 'tools/call',
        occurrance: 2,
        occurrence: 1,
        phase: 'operation',
      },
    },
  ])('rejects non-closed fault declaration %j', (declaration) => {
    expect(() => createMcpLabFaultPlan([declaration] as never)).toThrowError(
      /declaration.*only|match.*only/i
    );
  });

  it.each([
    [null, 'payload must be an object'],
    [
      { code: null, kind: 'child_exit', signal: null },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [
      { code: 3.7, kind: 'child_exit', signal: null },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [
      { code: -1, kind: 'child_exit', signal: null },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [
      { code: 256, kind: 'child_exit', signal: null },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [
      { code: null, kind: 'child_exit', signal: 'SIGNOTREAL' },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [
      { code: null, kind: 'child_exit', signal: 'SIGSTOP' },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [
      { code: 1, kind: 'child_exit', signal: 'SIGTERM' },
      'child exit must provide a code from 0 to 255 or a supported terminating signal',
    ],
    [{ kind: 'child_stderr', text: 42 }, 'child stderr text must be a string'],
    [{ kind: 'child_stderr', text: '' }, 'child stderr text must be non-empty'],
    [
      { extra: true, kind: 'child_stderr', text: 'message' },
      'child stderr must contain only "kind" and "text"',
    ],
    [{ kind: 'malformed_json', payload: 42 }, 'malformed JSON payload must be a string'],
    [{ kind: 'malformed_json', payload: '' }, 'malformed JSON payload must be non-empty'],
    [
      { kind: 'malformed_json', payload: '{}' },
      'malformed JSON payload must be syntactically invalid JSON',
    ],
    [
      { extra: true, kind: 'malformed_json', payload: '{' },
      'malformed JSON must contain only "kind" and "payload"',
    ],
    [{ delayMs: 1, extra: true, kind: 'delay' }, 'delay must contain only "kind" and "delayMs"'],
    [
      { extra: true, kind: 'http_status', status: 503 },
      'HTTP status must contain only "kind" and "status"',
    ],
    [
      { code: 0, extra: true, kind: 'child_exit', signal: null },
      'child exit must contain only "kind", "code", and "signal"',
    ],
    [{ kind: 'drop_response', reason: 'extra data' }, 'drop response must contain only "kind"'],
    [{ kind: 'cleanup_error', reason: 'extra data' }, 'cleanup error must contain only "kind"'],
  ])('rejects invalid untyped fault payload %j', (fault, expectedError) => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault,
          id: 'invalid-payload',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ] as never)
    ).toThrowError(`Invalid MCP lab fault "invalid-payload": ${expectedError}`);
  });

  it.each([
    { code: 0, kind: 'child_exit', signal: null },
    { code: null, kind: 'child_exit', signal: 'SIGTERM' },
  ] as const)('accepts a valid child exit payload %j', (fault) => {
    const plan = createMcpLabFaultPlan([
      {
        fault,
        id: 'valid-child-exit',
        match: { method: 'child/exit', occurrence: 1, phase: 'child-process' },
      },
    ]);
    expect(plan.hasRemainingPhase('child-process')).toBe(true);

    expect(
      plan.consume({
        correlationId: 'corr-child-exit',
        method: 'child/exit',
        occurrence: 1,
        phase: 'child-process',
      })
    ).toEqual(fault);
  });

  it('rejects an unknown phase with declaration context before method lookup', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'drop_response' },
          id: 'unknown-phase',
          match: { method: 'tools/call', occurrence: 1, phase: 'authorisation' },
        },
      ] as never)
    ).toThrowError('Invalid MCP lab fault "unknown-phase": unknown phase "authorisation"');
  });

  it.each([
    [
      { code: 7, kind: 'child_exit', signal: null },
      { method: 'tools/call', occurrence: 1, phase: 'operation' },
    ],
    [
      { kind: 'child_stderr', text: 'details' },
      { method: 'child/exit', occurrence: 1, phase: 'child-process' },
    ],
    [
      { kind: 'http_status', status: 503 },
      { method: 'child/exit', occurrence: 1, phase: 'child-process' },
    ],
    [{ kind: 'drop_response' }, { method: 'transport/close', occurrence: 1, phase: 'shutdown' }],
    [{ kind: 'cleanup_error' }, { method: 'tools/call', occurrence: 1, phase: 'operation' }],
  ])('rejects fault %j at incompatible coordinate %j', (fault, match) => {
    expect(() =>
      createMcpLabFaultPlan([{ fault, id: 'incompatible-coordinate', match }] as never)
    ).toThrowError(/incompatible.*coordinate/i);
  });

  it('consumes an exact phase, method, and occurrence with a redacted observation', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 25, kind: 'delay' },
        id: 'delay-second-tools-call',
        match: { method: 'tools/call', occurrence: 2, phase: 'operation' },
      },
    ]);
    expect(plan.hasRemainingPhase('operation')).toBe(true);

    expect(
      plan.consume({
        correlationId: 'corr-tools-2',
        method: 'tools/call',
        occurrence: 2,
        phase: 'operation',
      })
    ).toEqual({ delayMs: 25, kind: 'delay' });
    expect(plan.hasRemainingPhase('operation')).toBe(false);
    expect(plan.hasRemainingPhase('shutdown')).toBe(false);
    expect(plan.observations()).toEqual([
      {
        correlationId: 'corr-tools-2',
        faultId: 'delay-second-tools-call',
        faultKind: 'delay',
        method: 'tools/call',
        occurrence: 2,
        phase: 'operation',
      },
    ]);
  });

  it('rejects a method declared under the wrong protocol phase', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { delayMs: 25, kind: 'delay' },
          id: 'wrong-phase',
          match: { method: 'tools/call', occurrence: 1, phase: 'authorization' },
        },
      ])
    ).toThrowError(
      'Invalid MCP lab fault "wrong-phase": method "tools/call" does not belong to phase "authorization"'
    );
  });

  it('supports every declared fault as typed deterministic data', () => {
    const declarations = [
      {
        fault: { kind: 'http_status', status: 503 },
        id: 'status',
        match: { method: 'http/response', occurrence: 1, phase: 'transport' },
      },
      {
        fault: { delayMs: 10, kind: 'delay' },
        id: 'delay',
        match: { method: 'tools/call', occurrence: 2, phase: 'operation' },
      },
      {
        fault: { kind: 'malformed_json', payload: '{"broken":' },
        id: 'malformed',
        match: { method: 'initialize', occurrence: 3, phase: 'initialization' },
      },
      {
        fault: { kind: 'drop_response' },
        id: 'drop',
        match: { method: 'subscriptions/listen', occurrence: 4, phase: 'subscription' },
      },
      {
        fault: { kind: 'child_stderr', text: 'simulated child failure' },
        id: 'stderr',
        match: { method: 'child/stderr', occurrence: 5, phase: 'child-process' },
      },
      {
        fault: { code: null, kind: 'child_exit', signal: 'SIGTERM' },
        id: 'exit',
        match: { method: 'child/exit', occurrence: 6, phase: 'child-process' },
      },
      {
        fault: { kind: 'cleanup_error' },
        id: 'cleanup',
        match: { method: 'transport/close', occurrence: 7, phase: 'shutdown' },
      },
    ] as const satisfies readonly McpLabFaultDeclaration[];
    const consumptions: readonly McpLabFaultConsumption[] = declarations.map(
      ({ match }, index) => ({ ...match, correlationId: `corr-${index + 1}` })
    );
    const plan = createMcpLabFaultPlan(declarations);

    expect(consumptions.map((consumption) => plan.consume(consumption))).toEqual(
      declarations.map(({ fault }) => fault)
    );
  });

  it('rejects an unknown fault kind instead of degrading to a pass-through', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'disconnect-ish' },
          id: 'unknown-kind',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ] as never)
    ).toThrowError('Invalid MCP lab fault "unknown-kind": unknown fault kind "disconnect-ish"');
  });

  it.each([399, 600, 503.5])('rejects invalid HTTP fault status %s', (status) => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'http_status', status },
          id: `status-${status}`,
          match: { method: 'http/response', occurrence: 1, phase: 'transport' },
        },
      ])
    ).toThrowError(
      `Invalid MCP lab fault "status-${status}": HTTP status must be an integer from 400 to 599`
    );
  });

  it.each([0, -1, 1.25, 60_001, Number.NaN])('rejects invalid delay %s', (delayMs) => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { delayMs, kind: 'delay' },
          id: `delay-${delayMs}`,
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ])
    ).toThrowError(
      `Invalid MCP lab fault "delay-${delayMs}": delay must be an integer from 1 to 60000 ms`
    );
  });

  it.each([0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid occurrence %s',
    (occurrence) => {
      expect(() =>
        createMcpLabFaultPlan([
          {
            fault: { kind: 'drop_response' },
            id: `occurrence-${occurrence}`,
            match: { method: 'tools/call', occurrence, phase: 'operation' },
          },
        ])
      ).toThrowError(
        `Invalid MCP lab fault "occurrence-${occurrence}": occurrence must be a positive safe integer`
      );
    }
  );

  it('fails visibly for exhausted and unmatched consumption', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-first-call',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const configured = {
      correlationId: 'corr-first',
      method: 'tools/call',
      occurrence: 1,
      phase: 'operation',
    } as const;
    plan.consume(configured);

    expect(() => plan.consume(configured)).toThrowError(
      'MCP lab fault "drop-first-call" is exhausted for operation/tools/call occurrence 1'
    );
    expect(() =>
      plan.consume({ ...configured, correlationId: 'corr-second', occurrence: 2 })
    ).toThrowError('No MCP lab fault matches operation/tools/call occurrence 2');
  });

  it('optionally consumes configured faults without hiding exhausted coordinates', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'configured-drop',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const configured = {
      correlationId: 'corr-configured',
      method: 'tools/call',
      occurrence: 1,
      phase: 'operation',
    } as const;

    expect(
      plan.consumeIfConfigured({ ...configured, correlationId: 'corr-unconfigured', occurrence: 2 })
    ).toBeUndefined();
    expect(plan.consumeIfConfigured(configured)).toEqual({ kind: 'drop_response' });
    expect(() => plan.consumeIfConfigured(configured)).toThrowError(
      'MCP lab fault "configured-drop" is exhausted for operation/tools/call occurrence 1'
    );
  });

  it('reports sorted immutable untriggered fault ids', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'z-last',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
      {
        fault: { kind: 'drop_response' },
        id: 'a-first',
        match: { method: 'tools/call', occurrence: 2, phase: 'operation' },
      },
    ]);

    const ids = plan.untriggeredIds();
    expect(ids).toEqual(['a-first', 'z-last']);
    expect(Object.isFrozen(ids)).toBe(true);
    expect(Reflect.set(ids, 0, 'mutated')).toBe(false);

    plan.consume({
      correlationId: 'corr-first',
      method: 'tools/call',
      occurrence: 1,
      phase: 'operation',
    });
    expect(plan.untriggeredIds()).toEqual(['a-first']);
    expect(ids).toEqual(['a-first', 'z-last']);
  });

  it('isolates immutable observations from caller data and credentials', () => {
    const declaration = {
      fault: { delayMs: 15, kind: 'delay' as const },
      id: 'immutable-delay',
      match: { method: 'tools/call' as const, occurrence: 1, phase: 'operation' as const },
    };
    const plan = createMcpLabFaultPlan([declaration]);
    declaration.fault.delayMs = 30;

    const consumed = plan.consume({
      authorization: 'Bearer must-not-escape',
      correlationId: 'corr-safe',
      credentials: { accessToken: 'must-not-escape' },
      method: 'tools/call',
      occurrence: 1,
      phase: 'operation',
      requestBody: { secret: 'must-not-escape' },
    } as McpLabFaultConsumption);
    const observations = plan.observations();

    expect(consumed).toEqual({ delayMs: 15, kind: 'delay' });
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(observations)).toBe(true);
    expect(Object.isFrozen(observations[0])).toBe(true);
    expect(JSON.stringify(observations)).toBe(
      '[{"correlationId":"corr-safe","faultId":"immutable-delay","faultKind":"delay","method":"tools/call","occurrence":1,"phase":"operation"}]'
    );
  });

  it('rejects duplicate fault ids and duplicate match coordinates', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'drop_response' },
          id: 'duplicate-id',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
        {
          fault: { kind: 'drop_response' },
          id: 'duplicate-id',
          match: { method: 'tools/call', occurrence: 2, phase: 'operation' },
        },
      ])
    ).toThrowError('Duplicate MCP lab fault id: duplicate-id');

    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'drop_response' },
          id: 'first-coordinate-owner',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'second-coordinate-owner',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ])
    ).toThrowError(
      'Duplicate MCP lab fault match for operation/tools/call occurrence 1: first-coordinate-owner, second-coordinate-owner'
    );
  });

  it('fails closeout while configured faults remain untriggered', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'must-trigger',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);

    expect(() => plan.assertFullyConsumed()).toThrowError(
      'Untriggered MCP lab faults: must-trigger'
    );

    plan.consume({
      correlationId: 'corr-triggered',
      method: 'tools/call',
      occurrence: 1,
      phase: 'operation',
    });
    expect(() => plan.assertFullyConsumed()).not.toThrow();
  });
});
