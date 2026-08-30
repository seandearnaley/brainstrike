import {
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostOperationResult,
  parseConfiguredMcpServerId,
  parseMcpHostConfig,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { McpHostRevisionPublisher } from '../../mcp/host-revision-publisher';
import {
  type McpHostActor,
  type McpHostActorFactoryInput,
  McpHostService,
} from '../../mcp/host-service';

const alpha = parseConfiguredMcpServerId('alpha');
const beta = parseConfiguredMcpServerId('beta');
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
const flush = (): Promise<void> => Promise.resolve();
const config = (...servers: [typeof alpha, 'auto' | 'legacy'][]): McpHostConfig =>
  parseMcpHostConfig({
    servers: servers.map(([configuredServerId, configuredProtocol]) => ({
      auth: { type: 'none' },
      configuredProtocol,
      configuredServerId,
      transport: {
        configRef: '00000000-0000-4000-8000-000000000001',
        type: 'streamable-http',
      },
    })),
  });
interface ActorRecord {
  close: ReturnType<typeof vi.fn>;
  generation: number;
  invoke: ReturnType<typeof vi.fn>;
}
function setup(closeResults: Array<McpHostCloseReport | Promise<McpHostCloseReport>> = []) {
  const records: ActorRecord[] = [];
  const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
  const actorFactory = vi.fn((input: McpHostActorFactoryInput): McpHostActor => {
    const closeResult = closeResults[records.length] ?? CLEAN;
    const close = vi.fn(() => Promise.resolve(closeResult));
    const invoke = vi.fn(async () => RESULT);
    const actor: McpHostActor = {
      close,
      invoke,
      snapshot: () => ({
        configuredProtocol: input.config.configuredProtocol,
        configuredServerId: input.config.configuredServerId,
        generation: input.generation,
        state: 'disconnected',
        transport: input.config.transport.type,
      }),
    };
    records.push({ close, generation: input.generation, invoke });
    return actor;
  });
  return { actorFactory, host: new McpHostService({ actorFactory, publisher }), records };
}
describe('McpHostService', () => {
  it('implements exact-id routing, detached snapshots, watches, and unchanged retention', async () => {
    const { actorFactory, host, records } = setup();
    const listener = vi.fn();
    const unwatch = host.watch({}, listener);
    expect(host.snapshot()).toEqual({ revision: 0, servers: [] });
    const first = await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    await flush();
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
  it('passively drains accepted work and closes old before creating new without replay', async () => {
    const oldClosed = deferred<McpHostCloseReport>();
    const { host, records } = setup([oldClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto']));
    const accepted = host.invoke(LIST);
    const replacing = host.replaceConfig(config([alpha, 'legacy']));
    await flush();
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
    await flush();
    expect(records).toHaveLength(1);
    oldClosed.resolve(CLEAN);
    await Promise.all([first, second]);
    await host.replaceConfig(config());
    await host.replaceConfig(config([alpha, 'auto']));
    expect(records.map(({ generation }) => generation)).toEqual([1, 2, 3, 4]);
    expect(records.slice(0, 3).every(({ close }) => close.mock.calls.length === 1)).toBe(true);
  });
  it('aggregates replacement cleanup failure without publishing or disabling unaffected actors', async () => {
    const closeFailure = error('close-failed');
    const partial = closeReport([closeFailure], 2);
    const { host, records } = setup([partial]);
    await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
    const replacing = host.replaceConfig(config([alpha, 'legacy'], [beta, 'auto']));
    await expect(replacing).rejects.toMatchObject({
      category: 'transport',
      code: 'mcp-host-replacement-cleanup-failed',
      report: partial,
    });
    expect(host.snapshot().revision).toBe(1);
    expect(records).toHaveLength(2);
    await expect(host.replaceConfig(config([alpha, 'legacy'], [beta, 'legacy']))).rejects.toThrow();
    expect(records[1]?.close).not.toHaveBeenCalled();
    await host.invoke({ ...LIST, configuredServerId: beta });
    expect(records[1]?.invoke).toHaveBeenCalledOnce();
  });
  it('linearizes terminal close synchronously and returns one frozen aggregate report', async () => {
    const alphaClosed = deferred<McpHostCloseReport>();
    const betaClosed = deferred<McpHostCloseReport>();
    const closeFailure = error('partial-close');
    const { host, records } = setup([alphaClosed.promise, betaClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto'], [beta, 'auto']));
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
    alphaClosed.resolve(CLEAN);
    betaClosed.resolve(closeReport([closeFailure], 2, 0));
    const report = await closing;
    expect(report.callbacksClosed).toBe(2);
    expect(report.clientsClosed).toBe(1);
    expect(report.failures).toEqual([closeFailure]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.failures)).toBe(true);
    expect(await host.close()).toBe(report);
  });
  it('prevents a close-versus-replace race from publishing a post-close actor', async () => {
    const oldClosed = deferred<McpHostCloseReport>();
    const { host, records } = setup([oldClosed.promise]);
    await host.replaceConfig(config([alpha, 'auto']));
    const replacing = host.replaceConfig(config([alpha, 'legacy']));
    await flush();
    const closing = host.close();
    oldClosed.resolve(CLEAN);
    await expect(replacing).rejects.toMatchObject({ code: 'mcp-host-closed' });
    await closing;
    expect(records).toHaveLength(1);
    expect(host.snapshot().revision).toBe(1);
  });
});
