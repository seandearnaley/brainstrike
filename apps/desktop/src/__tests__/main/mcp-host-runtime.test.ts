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
  const runtime = createDesktopMcpHostRuntime({
    createActorClient: vi.fn(() => client()),
    createConfigRef: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    onInternalError,
  });
  return { onInternalError, runtime };
}
const publicConfig = (configRef: string, type: 'stdio' | 'streamable-http'): McpHostConfig =>
  parseMcpHostConfig({
    servers: [
      {
        auth: { type: 'none' },
        configuredProtocol: 'auto',
        configuredServerId: 'team.linear.prod',
        transport: { configRef, type },
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
    ] satisfies [ResolvedMcpServer, ResolvedMcpServer][];
    for (const [base, changed] of variants) {
      await runtime.replaceResolvedConfig(resolved(base));
      const first = replace.mock.lastCall?.[0].servers[0]?.transport.configRef;
      await runtime.replaceResolvedConfig(resolved(base));
      expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).toBe(first);
      await runtime.replaceResolvedConfig(resolved(changed));
      expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).not.toBe(first);
    }
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

  it('rejects malformed, unknown, and transport-mismatched refs visibly', async () => {
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
    const unknown = setup();
    await expect(
      unknown.runtime.host.replaceConfig(publicConfig(UNKNOWN, 'streamable-http'))
    ).rejects.toMatchObject({ code: 'mcp-host-actor-create-failed' });
    expect(unknown.onInternalError).toHaveBeenCalledWith(
      'mcp-host-actor-create-failed',
      expect.objectContaining({ code: 'mcp-config-ref-unknown' })
    );
    const mismatch = setup();
    await mismatch.runtime.replaceResolvedConfig(resolved(http()));
    await expect(
      mismatch.runtime.host.replaceConfig(publicConfig(REF, 'stdio'))
    ).rejects.toMatchObject({ code: 'mcp-host-actor-create-failed' });
    expect(mismatch.onInternalError).toHaveBeenCalledWith(
      'mcp-host-actor-create-failed',
      expect.objectContaining({ code: 'mcp-config-ref-transport-mismatch' })
    );
  });
});
