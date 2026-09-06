import { describe, expect, it, vi } from 'vitest';
import {
  McpAppFrameSession,
  type McpAppFrameSessionClaim,
  type McpAppFrameSessionMessageContext,
} from '../src/frame-session.js';
import { TestFrame, TestMessageTarget } from './frame-test-fixtures.js';

interface TestEnvelope {
  readonly id?: number | string;
  readonly method: string;
}

function parseTestEnvelope(value: unknown): TestEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('test envelope must be an object');
  }
  const method = Reflect.get(value, 'method');
  const id = Reflect.get(value, 'id');
  if (typeof method !== 'string') {
    throw new TypeError('test envelope method must be a string');
  }
  if (id !== undefined && typeof id !== 'number' && typeof id !== 'string') {
    throw new TypeError('test envelope id must be a number or string');
  }
  return id === undefined ? { method } : { id, method };
}

function claimEnvelope(
  context: McpAppFrameSessionMessageContext,
  value: unknown
): McpAppFrameSessionClaim {
  const envelope = parseTestEnvelope(value);
  return context.claim({
    kind: envelope.id === undefined ? 'notification' : 'request',
    method: envelope.method,
  });
}

describe('origin-bound MCP Apps frame session', () => {
  it('accepts only the bound opaque-origin source and live generation', () => {
    const target = new TestMessageTarget();
    const frame = new TestFrame();
    const attacker = new TestFrame();
    const errors: Error[] = [];
    const received: unknown[] = [];
    let live = true;
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => live,
      onMessage: (value) => received.push(value),
      onProtocolError: (error) => errors.push(error),
      onTeardown: () => undefined,
    });

    session.connect({ generation: 7, origin: 'null', source: frame });
    target.dispatch(attacker, { method: 'ui/initialize' });
    target.dispatch(frame, { method: 'ui/initialize' }, 'https://attacker.invalid');

    expect(received).toEqual([]);
    expect(errors.map((error) => error.message)).toEqual([
      'MCP Apps message source does not match the connected frame',
      'MCP Apps message origin does not match the connected frame',
    ]);
    expect(session.snapshot).toEqual({
      generation: 7,
      listenerCount: 1,
      phase: 'awaiting-initialize',
    });

    live = false;
    target.dispatch(frame, { method: 'ui/initialize' });
    expect(session.snapshot).toEqual({ listenerCount: 0, phase: 'disconnected' });
    expect(errors.at(-1)?.message).toBe('MCP Apps frame generation is stale');
  });

  it('reserves initialize and initialized phases before asynchronous work can reenter', () => {
    const target = new TestMessageTarget();
    const frame = new TestFrame();
    const errors: Error[] = [];
    const claims: McpAppFrameSessionClaim[] = [];
    const callbackMethods: string[] = [];
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => true,
      onMessage: (value, context) => {
        const envelope = parseTestEnvelope(value);
        const claim = claimEnvelope(context, value);
        callbackMethods.push(envelope.method);
        claims.push(claim);
      },
      onProtocolError: (error) => errors.push(error),
      onTeardown: () => undefined,
    });

    session.connect({ generation: 1, origin: 'null', source: frame });
    const initialize = { id: 'init', method: 'ui/initialize' };
    target.dispatch(frame, initialize);
    expect(session.snapshot.phase).toBe('initializing');

    target.dispatch(frame, initialize);
    expect(callbackMethods).toEqual(['ui/initialize']);
    expect(session.snapshot.phase).toBe('disconnected');
    expect(errors.at(-1)?.message).toBe(
      'MCP Apps frame sent traffic while ui/initialize is pending'
    );

    const replacement = new TestFrame();
    session.connect({ generation: 2, origin: 'null', source: replacement });
    target.dispatch(replacement, initialize);
    claims.at(-1)?.complete();
    expect(session.snapshot.phase).toBe('awaiting-initialized');

    const initialized = { method: 'ui/notifications/initialized' };
    target.dispatch(replacement, initialized);
    expect(session.snapshot.phase).toBe('accepting-initialized');
    target.dispatch(replacement, initialized);
    expect(callbackMethods).toEqual([
      'ui/initialize',
      'ui/initialize',
      'ui/notifications/initialized',
    ]);
    expect(session.snapshot.phase).toBe('disconnected');
    expect(errors.at(-1)?.message).toBe(
      'MCP Apps frame sent traffic while ui/notifications/initialized is pending'
    );
  });

  it('advances the exclusive handshake and rejects lifecycle replay', () => {
    const target = new TestMessageTarget();
    const frame = new TestFrame();
    const errors: Error[] = [];
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => true,
      onMessage: (value, context) => claimEnvelope(context, value).complete(),
      onProtocolError: (error) => errors.push(error),
      onTeardown: () => undefined,
    });

    session.connect({ generation: 1, origin: 'null', source: frame });
    target.dispatch(frame, { id: 'init', method: 'ui/initialize' });
    expect(session.snapshot.phase).toBe('awaiting-initialized');
    target.dispatch(frame, { method: 'ui/notifications/initialized' });
    expect(session.snapshot.phase).toBe('ready');

    target.dispatch(frame, { id: 'again', method: 'ui/initialize' });
    expect(session.snapshot.phase).toBe('disconnected');
    expect(errors.at(-1)?.message).toBe('MCP Apps frame replayed ui/initialize');
  });

  it('owns monotonic replacement, listener teardown, and terminal close', () => {
    const target = new TestMessageTarget();
    const first = new TestFrame();
    const second = new TestFrame();
    const teardownReasons: string[] = [];
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => true,
      onMessage: () => undefined,
      onProtocolError: () => undefined,
      onTeardown: (reason) => teardownReasons.push(reason.message),
    });

    session.connect({ generation: 1, origin: 'null', source: first });
    expect(target.listeners.size).toBe(1);
    session.replace({ generation: 2, origin: 'null', source: second });
    expect(target.listeners.size).toBe(1);
    expect(session.snapshot).toEqual({
      generation: 2,
      listenerCount: 1,
      phase: 'awaiting-initialize',
    });
    expect(teardownReasons).toEqual(['MCP Apps frame was replaced']);
    expect(() => session.replace({ generation: 2, origin: 'null', source: first })).toThrow(
      /must increase/
    );

    session.disconnect();
    expect(target.listeners.size).toBe(0);
    session.connect({ generation: 3, origin: 'null', source: new TestFrame() });
    session.close();
    expect(session.snapshot).toEqual({ listenerCount: 0, phase: 'closed' });
    expect(target.listeners.size).toBe(0);
    expect(() => session.connect({ generation: 4, origin: 'null', source: second })).toThrow(
      /closed/
    );
  });

  it('posts only through the current live generation and fails closed on send failure', () => {
    const target = new TestMessageTarget();
    const frame = new TestFrame();
    const errors: Error[] = [];
    let live = true;
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => live,
      onMessage: (value, context) => claimEnvelope(context, value).complete(),
      onProtocolError: (error) => errors.push(error),
      onTeardown: () => undefined,
    });

    session.connect({ generation: 9, origin: 'null', source: frame });
    target.dispatch(frame, { id: 'init', method: 'ui/initialize' });
    target.dispatch(frame, { method: 'ui/notifications/initialized' });
    session.post(9, { ready: true });
    expect(frame.sent).toEqual([{ message: { ready: true }, targetOrigin: '*' }]);

    live = false;
    expect(() => session.post(9, { stale: true })).toThrow(/no longer live/);
    expect(session.snapshot.phase).toBe('disconnected');
    expect(errors.at(-1)?.message).toBe('MCP Apps frame generation is no longer live');
  });

  it('fails closed when synchronous dispatch validation throws', () => {
    const target = new TestMessageTarget();
    const frame = new TestFrame();
    const errors: Error[] = [];
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => true,
      onMessage: () => {
        throw new TypeError('malformed frame message');
      },
      onProtocolError: (error) => errors.push(error),
      onTeardown: () => undefined,
    });

    session.connect({ generation: 1, origin: 'null', source: frame });
    target.dispatch(frame, { malformed: true });

    expect(session.snapshot).toEqual({ listenerCount: 0, phase: 'disconnected' });
    expect(errors.map((error) => error.message)).toEqual(['malformed frame message']);
  });

  it('rejects malformed and stale initial generations before listener installation', () => {
    const target = new TestMessageTarget();
    const frame = new TestFrame();
    const session = new McpAppFrameSession({
      eventTarget: target,
      isGenerationLive: () => false,
      onMessage: vi.fn(),
      onProtocolError: vi.fn(),
      onTeardown: vi.fn(),
    });

    expect(() => session.connect({ generation: 0, origin: 'null', source: frame })).toThrow(
      /positive safe integer/
    );
    expect(() => session.connect({ generation: 1, origin: 'null', source: frame })).toThrow(
      /not live/
    );
    expect(target.listeners.size).toBe(0);
  });
});
