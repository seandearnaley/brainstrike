import { describe, expect, it } from 'vitest';
import {
  assertScenarioFaultCompatibility,
  createMcpLabFaultPlan,
  isMcpLabCorrelationId,
  isMcpLabFaultPlan,
  type McpLabFaultConsumption,
  type McpLabFaultDeclaration,
} from '../src/faults';
import { getMcpLabScenario } from '../src/scenario';

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
    ).toThrowError(/fault id.*lowercase identifier/i);
  });

  it.each(['Authorization: Bearer opaque-secret', 'a'.repeat(129)])(
    'rejects unsafe or oversized fault ids without echoing their contents',
    (invalidId) => {
      try {
        createMcpLabFaultPlan([
          {
            fault: { kind: 'drop_response' },
            id: invalidId,
            match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
          },
        ]);
        throw new Error('expected the unsafe fault id to be rejected');
      } catch (error: unknown) {
        expect(String(error)).toMatch(/fault id.*lowercase identifier/i);
        expect(String(error)).not.toContain(invalidId);
      }
    }
  );

  it('snapshots accessor-backed declarations exactly once before validation', () => {
    let faultReads = 0;
    const declaration = Object.defineProperty(
      {
        id: 'accessor-backed-fault',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
      'fault',
      {
        enumerable: true,
        get() {
          faultReads += 1;
          return faultReads === 1 ? { delayMs: 1, kind: 'delay' } : { kind: 'cleanup_error' };
        },
      }
    );

    const plan = createMcpLabFaultPlan([declaration] as never);
    expect(faultReads).toBe(1);
    expect(
      plan.consume({
        correlationId: 'accessor-correlation',
        method: 'tools/call',
        occurrence: 1,
        phase: 'operation',
      })
    ).toEqual({ delayMs: 1, kind: 'delay' });
  });

  it('does not invoke a caller-controlled map while snapshotting declaration arrays', () => {
    let faultReads = 0;
    const declaration = Object.defineProperty(
      {
        id: 'proxied-declaration-array',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
      'fault',
      {
        enumerable: true,
        get() {
          faultReads += 1;
          return { delayMs: 1, kind: 'delay' };
        },
      }
    );
    const declarations = new Proxy([declaration], {
      get(target, property, receiver) {
        if (property === 'map') {
          return () => [declaration];
        }
        return Reflect.get(target, property, receiver);
      },
    });

    createMcpLabFaultPlan(declarations as never);
    expect(faultReads).toBe(1);
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

  it('rejects an enumerable __proto__ key in an untyped fault payload', () => {
    const fault: unknown = JSON.parse('{"kind":"drop_response","__proto__":{"extra":true}}');

    expect(() =>
      createMcpLabFaultPlan([
        {
          fault,
          id: 'invalid-proto-payload',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ] as never)
    ).toThrowError(
      'Invalid MCP lab fault "invalid-proto-payload": drop response must contain only "kind"'
    );
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
    ).toThrowError('Invalid MCP lab fault "unknown-phase": unknown phase');
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

  it('rejects child-process occurrences after the one start attempt', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { code: 7, kind: 'child_exit', signal: null },
          id: 'second-child-exit',
          match: { method: 'child/exit', occurrence: 2, phase: 'child-process' },
        },
      ])
    ).toThrowError(/child-process.*occurrence 1/i);
  });

  it('rejects shutdown occurrences that cannot be reached by retries', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'cleanup_error' },
          id: 'unreachable-second-close',
          match: { method: 'transport/close', occurrence: 2, phase: 'shutdown' },
        },
      ])
    ).toThrowError(/shutdown.*occurrence 2.*unreachable/i);

    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'successful-first-close',
          match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
        },
        {
          fault: { kind: 'cleanup_error' },
          id: 'unreachable-after-success',
          match: { method: 'transport/close', occurrence: 2, phase: 'shutdown' },
        },
      ])
    ).toThrowError(/shutdown.*occurrence 2.*unreachable/i);
  });

  it('accepts contiguous shutdown retries after explicit cleanup failures', () => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'cleanup_error' },
          id: 'failed-first-close',
          match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
        },
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'delayed-second-close',
          match: { method: 'transport/close', occurrence: 2, phase: 'shutdown' },
        },
      ])
    ).not.toThrow();
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

  it.each(['oauth/callback', 'oauth/revoke'])(
    'rejects unsupported authorization coordinate %s',
    (method) => {
      expect(() =>
        createMcpLabFaultPlan([
          {
            fault: { delayMs: 1, kind: 'delay' },
            id: 'unsupported-authorization',
            match: { method, occurrence: 1, phase: 'authorization' },
          },
        ] as never)
      ).toThrowError(/method.*does not belong|unknown/i);
    }
  );

  it('rejects operation coordinates unsupported by the selected fixture', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'unsupported-resource-subscription',
        match: { method: 'resources/subscribe', occurrence: 1, phase: 'operation' },
      },
    ]);

    expect(() => plan.assertCompatibleWithFixture('brainstrike-sdk-v2-reference')).toThrowError(
      /resources\/subscribe.*fixture/i
    );
  });

  it('rejects unknown compatibility discriminators instead of selecting a branch', () => {
    const plan = createMcpLabFaultPlan([]);

    expect(() => plan.assertCompatibleWithAuthentication('other' as never)).toThrowError(
      'Invalid MCP lab authentication mode'
    );
    expect(() => plan.assertCompatibleWithProtocolEra('other' as never)).toThrowError(
      'Invalid MCP lab protocol era'
    );
    expect(() => plan.assertCompatibleWithTransport('streamable-http' as never)).toThrowError(
      'Invalid MCP lab transport'
    );
    expect(() => plan.assertCompatibleWithFixture('other' as never)).toThrowError(
      'Invalid MCP lab fixture'
    );
  });

  it('maps canonical scenarios and execution topology through one compatibility gate', () => {
    const nodeDispatchPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'node-dispatch',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    const modern = getMcpLabScenario('modern-reference');

    expect(() =>
      assertScenarioFaultCompatibility(nodeDispatchPlan, modern, 'in-process')
    ).toThrowError(/http-in-process transport/i);
    expect(() =>
      assertScenarioFaultCompatibility(nodeDispatchPlan, modern, 'loopback')
    ).not.toThrow();
    const shutdownPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'shutdown-next-layer',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
    ]);
    expect(() =>
      assertScenarioFaultCompatibility(shutdownPlan, modern, 'in-process')
    ).not.toThrow();
    expect(() => assertScenarioFaultCompatibility(shutdownPlan, modern, 'loopback')).not.toThrow();
    expect(() =>
      assertScenarioFaultCompatibility(createMcpLabFaultPlan([]), modern, undefined)
    ).toThrowError('MCP lab streamable HTTP scenario requires an execution mode');
    expect(() => assertScenarioFaultCompatibility(undefined, modern, undefined)).toThrowError(
      'MCP lab streamable HTTP scenario requires an execution mode'
    );
    expect(() => assertScenarioFaultCompatibility(null as never, modern, 'loopback')).toThrowError(
      'Invalid MCP lab fault plan'
    );
    expect(() =>
      assertScenarioFaultCompatibility(undefined, { ...modern } as never, 'loopback')
    ).toThrowError('Invalid MCP lab scenario manifest');
    expect(() =>
      assertScenarioFaultCompatibility(
        createMcpLabFaultPlan([]),
        getMcpLabScenario('stdio-reference'),
        'loopback'
      )
    ).toThrowError('MCP lab stdio scenario does not accept an execution mode');
    expect(() =>
      assertScenarioFaultCompatibility(
        createMcpLabFaultPlan([]),
        { ...modern } as never,
        'loopback'
      )
    ).toThrowError('Invalid MCP lab scenario manifest');
  });

  it('publishes the bounded correlation-id predicate used by consumption', () => {
    expect(isMcpLabCorrelationId('corr-valid-1')).toBe(true);
    expect(isMcpLabCorrelationId('1')).toBe(true);
    expect(isMcpLabCorrelationId('short')).toBe(true);
    expect(isMcpLabCorrelationId('Authorization: Bearer secret')).toBe(false);
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
        match: { method: 'child/stderr', occurrence: 1, phase: 'child-process' },
      },
      {
        fault: { code: null, kind: 'child_exit', signal: 'SIGTERM' },
        id: 'exit',
        match: { method: 'child/exit', occurrence: 1, phase: 'child-process' },
      },
      {
        fault: { kind: 'cleanup_error' },
        id: 'cleanup',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
    ] as const satisfies readonly McpLabFaultDeclaration[];
    const consumptions: readonly McpLabFaultConsumption[] = declarations.map(
      ({ match }, index) => ({ ...match, correlationId: `correlation-${index + 1}` })
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
    ).toThrowError('Invalid MCP lab fault "unknown-kind": unknown fault kind');
  });

  it.each([Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid declaration count %s before indexed traversal',
    (declarationCount) => {
      const declarations = new Proxy([], {
        get(target, property, receiver) {
          return property === 'length' ? declarationCount : Reflect.get(target, property, receiver);
        },
      });

      expect(() => createMcpLabFaultPlan(declarations)).toThrowError(
        'Invalid MCP lab fault declarations: expected an integer count from 0 to 1024'
      );
    }
  );

  it.each([
    [
      { id: 'missing-fault', match: { method: 'tools/call', occurrence: 1, phase: 'operation' } },
      'fault',
    ],
    [{ fault: { kind: 'drop_response' }, id: 'missing-match' }, 'match'],
  ])('identifies a missing declaration %s field', (declaration, field) => {
    expect(() => createMcpLabFaultPlan([declaration] as never)).toThrowError(
      `Invalid MCP lab fault declaration: missing "${field}" field`
    );
  });

  it('contains hostile indexed accessor failures without echoing caller text', () => {
    const credential = 'Authorization: Bearer index-secret';
    const declarations = [
      {
        fault: { kind: 'drop_response' },
        id: 'indexed-accessor',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ] as McpLabFaultDeclaration[];
    Object.defineProperty(declarations, '0', {
      get() {
        throw new Error(credential);
      },
    });

    expect(() => createMcpLabFaultPlan(declarations)).toThrowError(
      'Invalid MCP lab fault declarations: could not snapshot entry'
    );
  });

  it('uses indexed snapshots without caller-controlled iteration or map', () => {
    const reads = { fault: 0, id: 0, match: 0 };
    const declaration = Object.defineProperties(
      {},
      {
        fault: {
          enumerable: true,
          get() {
            reads.fault += 1;
            return { kind: 'drop_response' };
          },
        },
        id: {
          enumerable: true,
          get() {
            reads.id += 1;
            return 'snapshot-once';
          },
        },
        match: {
          enumerable: true,
          get() {
            reads.match += 1;
            return { method: 'tools/call', occurrence: 1, phase: 'operation' };
          },
        },
      }
    );
    const declarations = [declaration] as unknown as McpLabFaultDeclaration[];
    Object.defineProperties(declarations, {
      map: {
        value: () => {
          throw new Error('map must not run');
        },
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error('iterator must not run');
        },
      },
    });

    const plan = createMcpLabFaultPlan(declarations);
    expect(reads).toEqual({ fault: 1, id: 1, match: 1 });
    expect(
      plan.consume({
        correlationId: 'corr-snapshot',
        method: 'tools/call',
        occurrence: 1,
        phase: 'operation',
      })
    ).toEqual({ kind: 'drop_response' });
  });

  it('rejects unsafe diagnostic identifiers before retention', () => {
    const credential = 'Authorization: Bearer must-not-escape';
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'drop_response' },
          id: credential,
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ])
    ).toThrowError('Invalid MCP lab fault id: expected a lowercase identifier');

    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'safe-id',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    expect(() =>
      plan.consume({
        correlationId: credential,
        method: 'tools/call',
        occurrence: 1,
        phase: 'operation',
      })
    ).toThrowError('Invalid MCP lab correlation id');
    expect(() => plan.assertFullyConsumed()).toThrowError('Untriggered MCP lab faults: safe-id');
  });

  it('brands and freezes only factory-created plans', () => {
    const plan = createMcpLabFaultPlan([]);
    expect(isMcpLabFaultPlan(plan)).toBe(true);
    expect(isMcpLabFaultPlan({ ...plan })).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Reflect.set(plan, 'consume', () => ({ kind: 'drop_response' }))).toBe(false);
  });

  it.each(['1', 'abc', 'req-1'])('accepts short safe correlation id %s', (correlationId) => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'short-correlation',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);

    expect(
      plan.consume({
        correlationId,
        method: 'tools/call',
        occurrence: 1,
        phase: 'operation',
      })
    ).toEqual({ kind: 'drop_response' });
  });

  it.each([399, 600, 503.5])('rejects invalid HTTP fault status %s', (status) => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { kind: 'http_status', status },
          id: 'invalid-status',
          match: { method: 'http/response', occurrence: 1, phase: 'transport' },
        },
      ])
    ).toThrowError(
      'Invalid MCP lab fault "invalid-status": HTTP status must be an integer from 400 to 599'
    );
  });

  it.each([0, -1, 1.25, 60_001, Number.NaN])('rejects invalid delay %s', (delayMs) => {
    expect(() =>
      createMcpLabFaultPlan([
        {
          fault: { delayMs, kind: 'delay' },
          id: 'invalid-delay',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ])
    ).toThrowError(
      'Invalid MCP lab fault "invalid-delay": delay must be an integer from 1 to 60000 ms'
    );
  });

  it.each([0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid occurrence %s',
    (occurrence) => {
      expect(() =>
        createMcpLabFaultPlan([
          {
            fault: { kind: 'drop_response' },
            id: 'invalid-occurrence',
            match: { method: 'tools/call', occurrence, phase: 'operation' },
          },
        ])
      ).toThrowError(
        'Invalid MCP lab fault "invalid-occurrence": occurrence must be a positive safe integer'
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
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Reflect.set(plan, 'consume', () => undefined)).toBe(false);
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

  it('rejects unsafe correlation ids before consuming or recording a fault', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'safe-correlation-only',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const credential = 'Authorization: Bearer opaque-secret';

    expect(() =>
      plan.consume({
        correlationId: credential,
        method: 'tools/call',
        occurrence: 1,
        phase: 'operation',
      })
    ).toThrowError(/correlation id/i);
    expect(JSON.stringify(plan.observations())).not.toContain(credential);
    expect(plan.untriggeredIds()).toEqual(['safe-correlation-only']);
  });

  it.each(['consume', 'consumeIfConfigured'] as const)(
    'snapshots accessor-backed consumptions exactly once in %s',
    (methodName) => {
      const plan = createMcpLabFaultPlan([
        {
          fault: { kind: 'drop_response' },
          id: 'snapshot-consumption',
          match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
        },
      ]);
      const reads = { correlationId: 0, method: 0, occurrence: 0, phase: 0 };
      const credential = 'Authorization: Bearer must-not-be-recorded';
      const consumption = Object.defineProperties(
        {},
        {
          correlationId: {
            enumerable: true,
            get() {
              reads.correlationId += 1;
              return reads.correlationId === 1 ? 'corr-safe' : credential;
            },
          },
          method: {
            enumerable: true,
            get() {
              reads.method += 1;
              return reads.method === 1 ? 'tools/call' : 'ping';
            },
          },
          occurrence: {
            enumerable: true,
            get() {
              reads.occurrence += 1;
              return reads.occurrence === 1 ? 1 : 2;
            },
          },
          phase: {
            enumerable: true,
            get() {
              reads.phase += 1;
              return reads.phase === 1 ? 'operation' : 'initialization';
            },
          },
        }
      ) as McpLabFaultConsumption;

      expect(plan[methodName](consumption)).toEqual({ kind: 'drop_response' });
      expect(reads).toEqual({ correlationId: 1, method: 1, occurrence: 1, phase: 1 });
      expect(plan.observations()).toEqual([
        {
          correlationId: 'corr-safe',
          faultId: 'snapshot-consumption',
          faultKind: 'drop_response',
          method: 'tools/call',
          occurrence: 1,
          phase: 'operation',
        },
      ]);
      expect(JSON.stringify(plan.observations())).not.toContain(credential);
    }
  );

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
