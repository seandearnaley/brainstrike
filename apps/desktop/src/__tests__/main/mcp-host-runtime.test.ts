import type { McpHostCloseReport, McpHostConfig } from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId, parseMcpHostConfig } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { McpHostService } from '../../mcp/host-service';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../../mcp-loader';

const REF = '00000000-0000-4000-8000-000000000001';
const UNKNOWN = '00000000-0000-4000-8000-000000000099';
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
const client = () => ({
  close: vi.fn(async () => CLEAN),
  invoke: vi.fn(async () => ({ tools: [] })),
  negotiated: {
    advertisedCapabilityIds: ['tools'],
    era: 'modern' as const,
    revision: '2026-07-28',
  },
});
type HttpServer = Extract<ResolvedMcpServer, { transport: 'streamable-http' }>;
type StdioServer = Extract<ResolvedMcpServer, { transport: 'stdio' }>;
const http = (patch: Partial<HttpServer> = {}): HttpServer => ({
  headers: { Authorization: 'Bearer private-token' },
  name: parseConfiguredMcpServerId('team.linear.prod'),
  protocol: 'auto',
  transport: 'streamable-http',
  url: 'https://linear.example/mcp',
  ...patch,
});
const stdio = (patch: Partial<StdioServer> = {}): StdioServer => ({
  args: ['--private-arg'],
  command: '/private/mcp-server',
  env: { PRIVATE_TOKEN: 'stdio-secret' },
  name: parseConfiguredMcpServerId('local.tools'),
  protocol: 'auto',
  transport: 'stdio',
  ...patch,
});
const resolved = (...servers: ResolvedMcpServer[]): ResolvedMcpConfig => ({ servers });

function setup() {
  let next = 0;
  const onInternalError = vi.fn();
  const createActorClient = vi.fn(() => client());
  const runtime = createDesktopMcpHostRuntime({
    createActorClient,
    createConfigRef: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    onInternalError,
  });
  return { createActorClient, onInternalError, runtime };
}
const publicConfig = (
  configRef: string,
  type: 'stdio' | 'streamable-http',
  patch: Partial<McpHostConfig['servers'][number]> = {}
): McpHostConfig =>
  parseMcpHostConfig({
    servers: [
      {
        auth: { type: 'none' },
        configuredProtocol: 'auto',
        configuredServerId: 'team.linear.prod',
        transport: { configRef, type },
        ...patch,
      },
    ],
  });

afterEach(() => vi.restoreAllMocks());

describe('DesktopMcpHostRuntime', () => {
  it('reuses refs only for identical private configs and exposes no private material', async () => {
    const replace = vi.spyOn(McpHostService.prototype, 'replaceConfig');
    const { runtime } = setup();
    const variants = [
      [http(), http({ url: 'https://linear.example/v2' })],
      [http(), http({ headers: { Authorization: 'Bearer changed' } })],
      [stdio(), stdio({ command: '/private/other-server' })],
      [stdio(), stdio({ args: ['--changed'] })],
      [stdio(), stdio({ env: { PRIVATE_TOKEN: 'changed' } })],
      [http(), http({ name: parseConfiguredMcpServerId('team.linear.next') })],
      [http(), http({ protocol: 'legacy' })],
      [http(), stdio({ name: parseConfiguredMcpServerId('team.linear.prod') })],
    ] satisfies [ResolvedMcpServer, ResolvedMcpServer][];
    for (const [base, changed] of variants) {
      await runtime.replaceResolvedConfig(resolved(base));
      const first = replace.mock.lastCall?.[0].servers[0]?.transport.configRef;
      await runtime.replaceResolvedConfig(resolved(base));
      expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).toBe(first);
      await runtime.replaceResolvedConfig(resolved(changed));
      expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).not.toBe(first);
    }
    await runtime.replaceResolvedConfig(resolved(http({ enabledTools: ['issues.list'] })));
    const preferenceRef = replace.mock.lastCall?.[0].servers[0]?.transport.configRef;
    await runtime.replaceResolvedConfig(resolved(http({ enabledTools: ['issues.get'] })));
    expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).toBe(preferenceRef);
    const snapshot = await runtime.replaceResolvedConfig(resolved(http(), stdio()));
    const exposed = JSON.stringify({ config: replace.mock.lastCall?.[0], snapshot });
    for (const value of [
      'linear.example',
      'Authorization',
      'private-token',
      '/private/mcp-server',
      '--private-arg',
      'PRIVATE_TOKEN',
      'stdio-secret',
    ]) {
      expect(exposed).not.toContain(value);
    }
  });

  it('snapshots private config and preserves committed refs during self-heal', async () => {
    const firstClose = Promise.withResolvers<void>();
    let created = 0;
    let invalidate: (() => void) | undefined;
    const createActorClient = vi.fn((_server: ResolvedMcpServer, context) => {
      created += 1;
      invalidate = context.onUnexpectedClose;
      const actorClient = client();
      if (created === 1) {
        actorClient.close = vi.fn(async () => {
          await firstClose.promise;
          return CLEAN;
        });
      }
      return actorClient;
    });
    const runtime = createDesktopMcpHostRuntime({ createActorClient, createConfigRef: () => REF });
    const original = http();
    await runtime.replaceResolvedConfig(resolved(original));
    if (!original.headers) {
      throw new Error('HTTP fixture must define private headers');
    }
    original.headers['Authorization'] = 'Bearer mutated-after-replacement';
    const operation = {
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      type: 'tools/list' as const,
    };
    await runtime.host.invoke(operation);
    expect(createActorClient.mock.calls[0]?.[0]).toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
    invalidate?.();
    const selfHeal = runtime.host.invoke(operation);
    const replacement = runtime.replaceResolvedConfig(
      resolved(http({ url: 'https://linear.example/next' }))
    );
    firstClose.resolve();
    await expect(selfHeal).resolves.toBeDefined();
    await expect(replacement).resolves.toBeDefined();
  });

  it('serializes direct replacements and isolates rejected async diagnostics', async () => {
    const deferred = Promise.withResolvers<ReturnType<McpHostService['snapshot']>>();
    const replace = vi
      .spyOn(McpHostService.prototype, 'replaceConfig')
      .mockImplementationOnce(async () => await deferred.promise)
      .mockResolvedValue({ revision: 2, servers: [] });
    const { runtime } = setup();
    const resolvedReplacement = runtime.replaceResolvedConfig(resolved(http()));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const directReplacement = runtime.host.replaceConfig(publicConfig(REF, 'streamable-http'));
    await Promise.resolve();
    expect(replace).toHaveBeenCalledOnce();
    deferred.resolve({ revision: 1, servers: [] });
    await Promise.all([resolvedReplacement, directReplacement]);

    vi.restoreAllMocks();
    const onInternalError = vi.fn(async () => {
      throw new Error('diagnostic sink rejected');
    });
    const failing = createDesktopMcpHostRuntime({
      createActorClient: vi.fn(async () => {
        throw new Error('connect failed');
      }),
      createConfigRef: () => REF,
      onInternalError,
    });
    await failing.replaceResolvedConfig(resolved(http()));
    await expect(
      failing.host.invoke({
        configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
        type: 'tools/list',
      })
    ).rejects.toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onInternalError).toHaveBeenCalled();
  });

  it('rejects malformed, duplicate, unknown, and mismatched refs visibly', async () => {
    const malformed = setup().runtime;
    const invalid = {
      servers: [
        {
          ...publicConfig(REF, 'streamable-http').servers[0],
          transport: { configRef: 'bad', type: 'streamable-http' },
        },
      ],
    } as unknown as McpHostConfig;
    await expect(malformed.host.replaceConfig(invalid)).rejects.toBeDefined();
    let refAttempt = 0;
    const recovering = createDesktopMcpHostRuntime({
      createActorClient: vi.fn(() => client()),
      createConfigRef: () => (++refAttempt === 1 ? 'bad' : REF),
    });
    await expect(recovering.replaceResolvedConfig(resolved(http()))).rejects.toBeDefined();
    await expect(recovering.replaceResolvedConfig(resolved(http()))).resolves.toBeDefined();
    expect(() =>
      parseMcpHostConfig({
        servers: [
          publicConfig(REF, 'streamable-http').servers[0],
          publicConfig(UNKNOWN, 'streamable-http').servers[0],
        ],
      })
    ).toThrow('duplicate configured server id');
    const unknown = setup();
    await expect(
      unknown.runtime.host.replaceConfig(publicConfig(UNKNOWN, 'streamable-http'))
    ).rejects.toMatchObject({ code: 'mcp-host-actor-create-failed' });
    expect(unknown.onInternalError).toHaveBeenCalledWith(
      'mcp-host-actor-create-failed',
      expect.objectContaining({ code: 'mcp-config-ref-unknown' })
    );
    for (const [config, code] of [
      [publicConfig(REF, 'stdio'), 'mcp-config-ref-transport-mismatch'],
      [
        publicConfig(REF, 'streamable-http', { configuredProtocol: 'legacy' }),
        'mcp-config-ref-protocol-mismatch',
      ],
      [
        publicConfig(REF, 'streamable-http', {
          configuredServerId: parseConfiguredMcpServerId('team.linear.next'),
        }),
        'mcp-config-ref-server-mismatch',
      ],
    ] as const) {
      const mismatch = setup();
      await mismatch.runtime.replaceResolvedConfig(resolved(http()));
      await expect(mismatch.runtime.host.replaceConfig(config)).rejects.toMatchObject({
        code: 'mcp-host-actor-create-failed',
      });
      expect(mismatch.onInternalError).toHaveBeenCalledWith(
        'mcp-host-actor-create-failed',
        expect.objectContaining({ code })
      );
    }
  });
});
