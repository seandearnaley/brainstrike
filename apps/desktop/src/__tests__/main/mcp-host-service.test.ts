import {
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostOperationResult,
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
  parseMcpHostConfig,
} from '@brainstrike/assistant-contract';
import { McpHostRevisionPublisher } from '@brainstrike/host-capabilities/mcp/host-revision-publisher';
import {
  type McpHostActor,
  type McpHostActorFactoryInput,
  McpHostService,
  McpHostServiceError,
} from '@brainstrike/host-capabilities/mcp/host-service';
import { describe, expect, it, vi } from 'vitest';

const alpha = parseConfiguredMcpServerId('alpha');
const beta = parseConfiguredMcpServerId('beta');
const gamma = parseConfiguredMcpServerId('gamma');
const FACTORY_FAILURE = new Error('factory failed');
const PUBLISH_FAILURE = new Error('publish failed');
const RESULT: McpHostOperationResult = { result: { tools: [] }, type: 'tools/list' };
const CLEAN: McpHostCloseReport = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
};
const LIST = { configuredServerId: alpha, type: 'tools/list' } as const;
const deferred = <T>() => Promise.withResolvers<T>();
const error = (code: string) => ({ category: 'transport', code, message: 'Failed' }) as const;
const closeReport = (
  failures: McpHostCloseReport['failures'],
  callbacksClosed = 0,
  clientsClosed = 1
): McpHostCloseReport => ({ ...CLEAN, callbacksClosed, clientsClosed, failures });
const yieldOneMicrotask = (): Promise<void> => Promise.resolve();
const config = (
  ...servers: [typeof alpha, 'auto' | 'legacy', ({ type: 'none' } | { type: 'oauth-user' })?][]
): McpHostConfig =>
  parseMcpHostConfig({
    servers: servers.map(([configuredServerId, configuredProtocol, auth = { type: 'none' }]) => ({
      auth,
      configuredProtocol,
      configuredServerId,
      ...(auth.type === 'oauth-user' ? { startup: 'authentication-required' } : {}),
      transport: {
        configRef: '00000000-0000-4000-8000-000000000001',
        type: 'streamable-http',
      },
    })),
  });
interface ActorRecord {
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  generation: number;
  invalidated: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  publish: McpHostActorFactoryInput['onSnapshotChanged'];
  snapshot: ReturnType<typeof vi.fn<() => McpHostServerSnapshot>>;
}
function setup(
  closeResults: Array<McpHostCloseReport | Promise<McpHostCloseReport>> = [],
  factoryFailureAt?: number
) {
  const records: ActorRecord[] = [];
  const diagnostic = vi.fn();
  const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
  const actorFactory = vi.fn((input: McpHostActorFactoryInput): McpHostActor => {
    if (records.length === factoryFailureAt) {
      throw FACTORY_FAILURE;
    }
    const closeResult = closeResults[records.length] ?? CLEAN;
    const close = vi.fn(() => Promise.resolve(closeResult));
    const invalidated = vi.fn(() => false);
    const invoke = vi.fn(async () => RESULT);
    const snapshot = vi.fn(() => ({
      configuredProtocol: input.config.configuredProtocol,
      configuredServerId: input.config.configuredServerId,
      generation: input.generation,
      state: 'disconnected' as const,
      transport: input.config.transport.type,
    }));
    const connect = vi.fn(async () => ({
      ...snapshot(),
      negotiated: {
        advertisedCapabilityIds: ['tools'],
        era: 'modern' as const,
        revision: '2026-07-28' as const,
      },
      state: 'connected' as const,
    }));
    const cancel = vi.fn(async () => ({ ...snapshot(), state: 'disconnected' as const }));
    const disconnect = vi.fn(async () => ({
      ...snapshot(),
      state: 'authentication-required' as const,
    }));
    const actor: McpHostActor = {
      cancel,
      close,
      connect,
      disconnect,
      invalidated,
      invoke,
      snapshot,
    };
    records.push({
      cancel,
      close,
      connect,
      disconnect,
      generation: input.generation,
      invalidated,
      invoke,
      publish: input.onSnapshotChanged,
      snapshot,
    });
    return actor;
  });
  return {
    actorFactory,
    diagnostic,
    host: new McpHostService({ actorFactory, onInternalError: diagnostic, publisher }),
    publisher,
    records,
  };
}
describe('McpHostService', () => {
  it('publishes the retiring generation until its physical close joins while fencing invocation', async () => {
    const { diagnostic, host, records } = setup();
    await host.replaceConfig(config([alpha, 'auto']));
    const actor = records[0]!;
    const entered = deferred<void>();
    const joined = deferred<void>();
    actor.close.mockImplementation(async () => {
      actor.publish({ ...actor.snapshot(), state: 'closing' });
      entered.resolve();
      await joined.promise;
      actor.publish({ ...actor.snapshot(), state: 'disconnected' });
      return CLEAN;
    });
    const replacement = host.replaceConfig(config());
    await entered.promise;
    expect(host.snapshot().servers[0]?.state).toBe('closing');
    expect(diagnostic).not.toHaveBeenCalled();
    const invocation = expect(host.invoke(LIST)).rejects.toMatchObject({
      code: 'mcp-host-server-unknown',
    });
    expect(actor.invoke).not.toHaveBeenCalled();
    joined.resolve();
    await replacement;
    await invocation;
    expect(host.snapshot().servers).toEqual([]);
    expect(actor.invoke).not.toHaveBeenCalled();
    expect(diagnostic).not.toHaveBeenCalled();
    actor.publish({ ...actor.snapshot(), state: 'connecting' });
    expect(diagnostic).toHaveBeenCalledWith(
      'mcp-host-unpublished-actor-transition',
      expect.objectContaining({ configuredServerId: alpha, state: 'connecting' })
    );
    await host.close();
  });
  it('connects, cancels, disconnects, and reauthorizes one selected OAuth actor', async () => {
    const { host, records } = setup();
    await host.replaceConfig(config([alpha, 'auto', { type: 'oauth-user' }]));

    await host.control({ action: 'connect', configuredServerId: alpha });
    expect(records[0]?.connect).toHaveBeenCalledOnce();

    await host.control({ action: 'cancel', configuredServerId: alpha });
    expect(records[0]?.cancel).toHaveBeenCalledOnce();

    await host.control({ action: 'disconnect', configuredServerId: alpha });
    expect(records[0]?.disconnect).toHaveBeenCalledOnce();
    expect(records[1]?.generation).toBe(2);
    expect(records[1]?.connect).not.toHaveBeenCalled();

    await host.control({ action: 'reauthorize', configuredServerId: alpha });
    expect(records[1]?.disconnect).toHaveBeenCalledOnce();
    expect(records[2]?.generation).toBe(3);
    expect(records[2]?.connect).toHaveBeenCalledOnce();
    expect(records).toHaveLength(3);
  });

  it('retries machine and OAuth connections with a fresh generation', async () => {
    const machine = setup();
    await machine.host.replaceConfig(config([alpha, 'auto']));
    await machine.host.control({ action: 'retry', configuredServerId: alpha });
    expect(machine.records[0]?.close).toHaveBeenCalledOnce();
    expect(machine.records[1]?.generation).toBe(2);
    expect(machine.records[1]?.connect).toHaveBeenCalledOnce();

    const oauth = setup();
    await oauth.host.replaceConfig(config([alpha, 'auto', { type: 'oauth-user' }]));
    await oauth.host.control({ action: 'retry', configuredServerId: alpha });
    expect(oauth.records[0]?.close).toHaveBeenCalledOnce();
    expect(oauth.records[1]?.generation).toBe(2);
    expect(oauth.records[1]?.connect).toHaveBeenCalledOnce();
  });
  it('does not hold configuration replacement behind a user-paced connect', async () => {
    const { host, records } = setup();
    await host.replaceConfig(config([alpha, 'auto']));
    const pendingSnapshot = host.snapshot().servers[0];
    if (!pendingSnapshot) {
      throw new Error('Expected configured actor snapshot');
    }
    const connectGate = Promise.withResolvers<void>();
    records[0]?.connect.mockImplementation(async () => {
      await connectGate.promise;
      return {
        ...pendingSnapshot,
        negotiated: {
          advertisedCapabilityIds: ['tools'],
          era: 'modern' as const,
          revision: '2026-07-28' as const,
        },
        state: 'connected' as const,
      };
    });

    const connecting = host.control({ action: 'connect', configuredServerId: alpha });
    await vi.waitFor(() => expect(records[0]?.connect).toHaveBeenCalledOnce());
    await expect(host.replaceConfig(config([beta, 'auto']))).resolves.toBeDefined();

    connectGate.resolve();
    await expect(connecting).resolves.toBeDefined();
  });
  it('does not let a queued control reapply a stale configuration', async () => {
    const { host } = setup();
    const first = host.replaceConfig(config([alpha, 'auto']));
    const second = host.replaceConfig(config([beta, 'auto']));
    const staleControl = host.control({ action: 'retry', configuredServerId: alpha });

    await Promise.all([first, second]);
    await expect(staleControl).rejects.toMatchObject({ code: 'mcp-host-server-unknown' });
    expect(host.snapshot().servers[0]?.configuredServerId).toBe(beta);
  });
  it('implements exact-id routing, detached snapshots, watches, and unchanged retention', async () => {
    const { actorFactory, host, records } = setup();
    const listener = vi.fn();
    const unwatch = host.watch({}, listener);
    expect(host.snapshot()).toEqual({ revision: 0, servers: [] });
    const first = await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    await yieldOneMicrotask();
    const ids = first.servers.map(({ configuredServerId }) => configuredServerId);
    expect(ids).toEqual([alpha, beta]);
    expect(first.servers).not.toBe(host.snapshot().servers);
    expect(listener).toHaveBeenCalledOnce();
    await host.invoke(LIST);
    expect(records[0]?.invoke).toHaveBeenCalledOnce();
    expect(records[1]?.invoke).not.toHaveBeenCalled();
    expect((await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']))).revision).toBe(1);
    expect(actorFactory).toHaveBeenCalledTimes(2);
    expect(records.every(({ close }) => close.mock.calls.length === 0)).toBe(true);
    unwatch();
  });
  it('keeps canonical authority order when retained and provisional actors are mixed', async () => {
    const { host } = setup();
    await host.replaceConfig(config([beta, 'auto']));
    const mixed = await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    expect(mixed.servers.map(({ configuredServerId }) => configuredServerId)).toEqual([
      alpha,
      beta,
    ]);
  });
  it('returns rejected promises for malformed replacement config and gives terminal close precedence', async () => {
    const { host } = setup();
    const malformed = { servers: null } as unknown as McpHostConfig;
    const replacement = host.replaceConfig(malformed);
    expect(replacement).toBeInstanceOf(Promise);
    await expect(replacement).rejects.toBeDefined();
    await host.close();
    await expect(host.replaceConfig(malformed)).rejects.toMatchObject({
      category: 'host-closed',
      code: 'mcp-host-closed',
    });
  });
  it('validates invoke and control payloads at the host-service boundary', async () => {
    const { host, records } = setup();
    await host.replaceConfig(config([alpha, 'auto']));

    await expect(host.invoke({ ...LIST, extra: true } as unknown as typeof LIST)).rejects.toThrow();
    await expect(
      host.control({ action: 'unknown', configuredServerId: alpha } as unknown as {
        action: 'connect';
        configuredServerId: typeof alpha;
      })
    ).rejects.toThrow();
    expect(records[0]?.invoke).not.toHaveBeenCalled();
    expect(records[0]?.connect).not.toHaveBeenCalled();
  });
  it('passively drains accepted work and closes old before creating new without replay', async () => {
    const oldClosed = deferred<McpHostCloseReport>();
    const { host, records } = setup([oldClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto']));
    const accepted = host.invoke(LIST);
    const replacing = host.replaceConfig(config([alpha, 'legacy']));
    await yieldOneMicrotask();
    expect(records[0]?.invoke).toHaveBeenCalledOnce();
    expect(records[0]?.close).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    oldClosed.resolve(CLEAN);
    await expect(accepted).resolves.toEqual(RESULT);
    await replacing;
    expect(records.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(records[0]?.invoke).toHaveBeenCalledOnce();
    expect((await host.close()).clientsClosed).toBe(2);
  });
  it('serializes concurrent replacements and keeps lifetime generations monotonic', async () => {
    const oldClosed = deferred<McpHostCloseReport>();
    const { host, records } = setup([oldClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto']));
    const first = host.replaceConfig(config([alpha, 'legacy']));
    const second = host.replaceConfig(config([alpha, 'auto']));
    await yieldOneMicrotask();
    expect(records).toHaveLength(1);
    oldClosed.resolve(CLEAN);
    await Promise.all([first, second]);
    await host.replaceConfig(config());
    await host.replaceConfig(config([alpha, 'auto']));
    expect(records.map(({ generation }) => generation)).toEqual([1, 2, 3, 4]);
    expect(records.slice(0, 3).every(({ close }) => close.mock.calls.length === 1)).toBe(true);
  });
  it('replaces only the invoked invalidated server once on the next operation', async () => {
    const { host, records } = setup();
    await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    records[0]?.invalidated.mockReturnValue(true);
    records[1]?.invalidated.mockReturnValue(true);
    await Promise.all([host.invoke(LIST), host.invoke(LIST)]);
    expect(records.map(({ generation }) => generation)).toEqual([1, 1, 2]);
    expect(records[2]?.invoke).toHaveBeenCalledTimes(2);
  });
  it('cancels queued invokes and rechecks invalidation before routing later work', async () => {
    const betaClosed = deferred<McpHostCloseReport>();
    const { host, records } = setup([CLEAN, betaClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    void host.replaceConfig(config([alpha, 'auto']));
    await yieldOneMicrotask();
    records[0]?.invalidated.mockReturnValue(true);
    const controller = new AbortController();
    const reason = new DOMException('Caller cancelled', 'AbortError');
    const cancelled = host.invoke(LIST, { signal: controller.signal });
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    await expect(host.invoke(LIST, { signal: controller.signal })).rejects.toBe(reason);
    const invoked = host.invoke(LIST);
    betaClosed.resolve(CLEAN);
    await expect(invoked).resolves.toEqual(RESULT);
    expect(records[0]?.invoke).not.toHaveBeenCalled();
    expect(records[2]?.invoke).toHaveBeenCalledOnce();
  });
  it('latches one stable aggregate after attempting every failed retirement', async () => {
    const closeCause = new Error('raw close failure');
    const rejectedClose = deferred<McpHostCloseReport>();
    const closeFailure = error('close-failed');
    const partial = closeReport([closeFailure], 2);
    const { diagnostic, host, records } = setup([rejectedClose.promise, partial]);
    await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto'], [gamma, 'auto']));
    const replacing = host.replaceConfig(config([gamma, 'auto']));
    await yieldOneMicrotask();
    const connectedGamma = {
      configuredProtocol: 'auto' as const,
      configuredServerId: gamma,
      generation: 1,
      negotiated: {
        advertisedCapabilityIds: ['tools'],
        era: 'modern' as const,
        revision: '2026-07-28' as const,
      },
      state: 'connected' as const,
      transport: 'streamable-http' as const,
    };
    records[2]?.snapshot.mockReturnValue(connectedGamma);
    records[2]?.publish(connectedGamma);
    rejectedClose.reject(closeCause);
    const firstFailure: unknown = await replacing.catch((cause: unknown) => cause);
    expect(firstFailure).toMatchObject({
      category: 'transport',
      code: 'mcp-host-replacement-cleanup-failed',
      report: {
        callbacksClosed: 2,
        failures: [expect.objectContaining({ code: 'mcp-host-actor-close-failed' }), closeFailure],
      },
    });
    expect(firstFailure).toBeInstanceOf(McpHostServiceError);
    if (!(firstFailure instanceof McpHostServiceError)) {
      throw new Error('Expected McpHostServiceError');
    }
    expect(host.snapshot()).toMatchObject({
      revision: 3,
      servers: [{ configuredServerId: gamma, state: 'connected' }],
    });
    expect(records.slice(0, 2).every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    expect(records[2]?.close).not.toHaveBeenCalled();
    const retry: unknown = await host
      .replaceConfig(config([gamma, 'auto']))
      .catch((cause) => cause);
    expect(retry).toBeInstanceOf(McpHostServiceError);
    if (!(retry instanceof McpHostServiceError)) {
      throw new Error('Expected retry McpHostServiceError');
    }
    expect(retry.report).toBe(firstFailure.report);
    await host.invoke({ ...LIST, configuredServerId: gamma });
    expect(records[2]?.invoke).toHaveBeenCalledOnce();
    await expect(host.invoke(LIST)).rejects.toMatchObject({ code: 'mcp-host-server-unknown' });
    expect(diagnostic).toHaveBeenCalledWith('mcp-host-actor-close-failed', closeCause);
  });
  it('diagnoses a transition emitted before its actor is published', async () => {
    const diagnostic = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    const host = new McpHostService({
      actorFactory: (input) => {
        input.onSnapshotChanged({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          generation: input.generation,
          state: 'connecting',
          transport: input.config.transport.type,
        });
        return {
          cancel: async () => ({
            configuredProtocol: input.config.configuredProtocol,
            configuredServerId: input.config.configuredServerId,
            generation: input.generation,
            state: 'disconnected',
            transport: input.config.transport.type,
          }),
          close: async () => CLEAN,
          connect: async () => ({
            configuredProtocol: input.config.configuredProtocol,
            configuredServerId: input.config.configuredServerId,
            generation: input.generation,
            negotiated: {
              advertisedCapabilityIds: ['tools'],
              era: 'modern' as const,
              revision: '2026-07-28' as const,
            },
            state: 'connected' as const,
            transport: input.config.transport.type,
          }),
          disconnect: async () => ({
            configuredProtocol: input.config.configuredProtocol,
            configuredServerId: input.config.configuredServerId,
            generation: input.generation,
            state: 'disconnected',
            transport: input.config.transport.type,
          }),
          invalidated: () => false,
          invoke: async () => RESULT,
          snapshot: () => ({
            configuredProtocol: input.config.configuredProtocol,
            configuredServerId: input.config.configuredServerId,
            generation: input.generation,
            state: 'disconnected',
            transport: input.config.transport.type,
          }),
        };
      },
      onInternalError: diagnostic,
      publisher,
    });
    await host.replaceConfig(config([alpha, 'auto']));
    expect(diagnostic).toHaveBeenCalledWith(
      'mcp-host-unpublished-actor-transition',
      expect.objectContaining({ configuredServerId: alpha, state: 'connecting' })
    );
  });
  it('closes provisional actors and publishes nothing when creation fails', async () => {
    const { diagnostic, host, records } = setup([], 1);
    await expect(host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']))).rejects.toMatchObject(
      {
        code: 'mcp-host-actor-create-failed',
      }
    );
    expect(records[0]?.close).toHaveBeenCalledOnce();
    expect(host.snapshot()).toEqual({ revision: 0, servers: [] });
    const provisional = records[0];
    if (!provisional) {
      throw new Error('Expected provisional actor');
    }
    expect(() =>
      provisional.publish({
        configuredProtocol: 'auto',
        configuredServerId: alpha,
        generation: provisional.generation,
        state: 'disconnected',
        transport: 'streamable-http',
      })
    ).not.toThrow();
    expect(host.snapshot()).toEqual({ revision: 0, servers: [] });
    await expect(host.invoke(LIST)).rejects.toMatchObject({ code: 'mcp-host-server-unknown' });
    expect(diagnostic).toHaveBeenCalledWith('mcp-host-actor-create-failed', FACTORY_FAILURE);
  });
  it('latches failed provisional cleanup with the same frozen proof', async () => {
    const cleanupFailure = closeReport([error('provisional-close-failed')]);
    const { host } = setup([cleanupFailure], 1);
    const first: unknown = await host
      .replaceConfig(config([alpha, 'auto'], [beta, 'auto']))
      .catch((cause) => cause);
    expect(first).toMatchObject({ code: 'mcp-host-replacement-cleanup-failed' });
    if (!(first instanceof McpHostServiceError)) {
      throw new Error('Expected provisional cleanup McpHostServiceError');
    }
    const retry: unknown = await host.replaceConfig(config()).catch((cause) => cause);
    expect(retry).toBeInstanceOf(McpHostServiceError);
    if (!(retry instanceof McpHostServiceError)) {
      throw new Error('Expected retry cleanup McpHostServiceError');
    }
    expect(retry.report).toBe(first.report);
  });
  it('reaps provisional actors and restores retained authority after publication fails', async () => {
    const { diagnostic, host, publisher, records } = setup();
    vi.spyOn(publisher, 'publishConfigSet').mockImplementationOnce(() => {
      throw PUBLISH_FAILURE;
    });
    await expect(host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']))).rejects.toMatchObject(
      { code: 'mcp-host-publish-failed' }
    );
    expect(records).toHaveLength(2);
    expect(records.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    expect(host.snapshot()).toEqual({ revision: 0, servers: [] });
    await expect(host.invoke(LIST)).rejects.toMatchObject({ code: 'mcp-host-server-unknown' });
    await expect(host.replaceConfig(config([gamma, 'auto']))).resolves.toMatchObject({
      servers: [{ configuredServerId: gamma }],
    });
    expect(diagnostic).toHaveBeenCalledWith('mcp-host-publish-failed', PUBLISH_FAILURE);
  });
  it('preserves a failed-retirement latch when retained-authority reconciliation fails', async () => {
    const cleanupFailure = closeReport([error('retirement-close-failed')]);
    const { host, publisher } = setup([cleanupFailure]);
    await host.replaceConfig(config([alpha, 'auto']));
    vi.spyOn(publisher, 'publishConfigSet').mockImplementationOnce(() => {
      throw PUBLISH_FAILURE;
    });
    await expect(host.replaceConfig(config())).rejects.toMatchObject({
      code: 'mcp-host-publish-failed',
    });
    const retry: unknown = await host.replaceConfig(config()).catch((cause) => cause);
    expect(retry).toBeInstanceOf(McpHostServiceError);
    if (!(retry instanceof McpHostServiceError)) {
      throw new Error('Expected retry cleanup McpHostServiceError');
    }
    expect(retry).toMatchObject({
      code: 'mcp-host-replacement-cleanup-failed',
      report: { failures: [expect.objectContaining({ code: 'retirement-close-failed' })] },
    });
    await expect(host.invoke(LIST)).rejects.toMatchObject({ code: 'mcp-host-server-unknown' });
  });
  it('linearizes terminal close synchronously and returns one frozen aggregate report', async () => {
    const alphaClosed = deferred<McpHostCloseReport>();
    const betaClosed = deferred<McpHostCloseReport>();
    const closeFailure = error('partial-close');
    const { host, records } = setup([alphaClosed.promise, betaClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    host.watch({}, vi.fn());
    host.watch({ configuredServerIds: [alpha] }, vi.fn());
    const accepted = host.invoke(LIST);
    const closing = host.close();
    expect(host.close()).toBe(closing);
    await expect(accepted).resolves.toEqual(RESULT);
    expect(records.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    await expect(host.invoke(LIST)).rejects.toMatchObject({ code: 'mcp-host-closed' });
    await expect(host.replaceConfig(config())).rejects.toMatchObject({ code: 'mcp-host-closed' });
    expect(() => host.watch({}, vi.fn())).toThrowError(
      expect.objectContaining({ code: 'mcp-host-closed' })
    );
    alphaClosed.resolve(closeReport([], 0, Number.MAX_SAFE_INTEGER));
    betaClosed.resolve(closeReport([closeFailure], 2, 1));
    const report = await closing;
    expect(report.callbacksClosed).toBe(2);
    expect(report.clientsClosed).toBe(Number.MAX_SAFE_INTEGER);
    expect(report.subscriptionsClosed).toBe(2);
    expect(report.failures).toEqual([
      closeFailure,
      expect.objectContaining({ code: 'mcp-host-close-counter-overflow' }),
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.failures)).toBe(true);
    expect(await host.close()).toBe(report);
  });
  it('suppresses actor transitions after terminal close starts', async () => {
    const diagnostic = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: diagnostic });
    const host = new McpHostService({
      actorFactory: (input) => ({
        cancel: async () => ({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          generation: input.generation,
          state: 'disconnected',
          transport: input.config.transport.type,
        }),
        close: async () => {
          input.onSnapshotChanged({
            configuredProtocol: input.config.configuredProtocol,
            configuredServerId: input.config.configuredServerId,
            generation: input.generation,
            state: 'disconnected',
            transport: input.config.transport.type,
          });
          return CLEAN;
        },
        connect: async () => ({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          generation: input.generation,
          negotiated: {
            advertisedCapabilityIds: ['tools'],
            era: 'modern' as const,
            revision: '2026-07-28' as const,
          },
          state: 'connected' as const,
          transport: input.config.transport.type,
        }),
        disconnect: async () => ({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          generation: input.generation,
          state: 'disconnected',
          transport: input.config.transport.type,
        }),
        invalidated: () => false,
        invoke: async () => RESULT,
        snapshot: () => ({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          generation: input.generation,
          negotiated: {
            advertisedCapabilityIds: ['tools'],
            era: 'modern',
            revision: '2026-07-28',
          },
          state: 'connected',
          transport: input.config.transport.type,
        }),
      }),
      onInternalError: diagnostic,
      publisher,
    });
    await host.replaceConfig(config([alpha, 'auto']));
    await expect(host.close()).resolves.toMatchObject({ failures: [] });
    expect(diagnostic).not.toHaveBeenCalled();
  });
  it('prevents a close-versus-replace race from publishing a post-close actor', async () => {
    const oldClosed = deferred<McpHostCloseReport>();
    const { host, records } = setup([oldClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto']));
    const replacing = host.replaceConfig(config([alpha, 'legacy']));
    await yieldOneMicrotask();
    const closing = host.close();
    oldClosed.resolve(CLEAN);
    await expect(replacing).rejects.toMatchObject({ code: 'mcp-host-closed' });
    await closing;
    expect(records).toHaveLength(1);
    expect(host.snapshot().revision).toBe(1);
  });
});
