import { describe, expect, it } from 'vitest';
import {
  createMcpLabFaultPlan,
  isMcpLabFaultPlan,
  type McpLabFaultConsumption,
  type McpLabFaultDeclaration,
} from '../src/faults';

describe('MCP lab fault plan', () => {
  it('consumes an exact phase, method, and occurrence with a redacted observation', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 25, kind: 'delay' },
        id: 'delay-second-tools-call',
        match: { method: 'tools/call', occurrence: 2, phase: 'operation' },
      },
    ]);

    expect(
      plan.consume({
        correlationId: 'corr-tools-2',
        method: 'tools/call',
        occurrence: 2,
        phase: 'operation',
      })
    ).toEqual({ delayMs: 25, kind: 'delay' });
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

  it('bounds hostile declaration arrays before indexed traversal', () => {
    const declarations = new Proxy([], {
      get(target, property, receiver) {
        return property === 'length'
          ? Number.POSITIVE_INFINITY
          : Reflect.get(target, property, receiver);
      },
    });

    expect(() => createMcpLabFaultPlan(declarations)).toThrowError(
      'Invalid MCP lab fault declarations: expected at most 1024 entries'
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
