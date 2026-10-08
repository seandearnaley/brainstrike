import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import { expect, it } from 'vitest';
import type { McpBearerCredentialAuthority } from '../src/mcp/bearer-credential.js';
import { createMcpHostServices } from '../src/mcp/mcp-host-services.js';
import type { McpOAuthStore } from '../src/mcp/oauth-client-provider.js';

const unused = (): never => {
  throw new Error('No OAuth record is read for a bearer server.');
};
const oauthStore: McpOAuthStore = {
  clear: unused,
  clearAll: unused,
  read: unused,
  write: unused,
};

// Credential reads can wait for work that only starts after host readiness
// (the legacy credential import), so readiness never waits for server startup.
it('composes the MCP runtime before a configured server inspects its credential', async () => {
  const gate = Promise.withResolvers<void>();
  let inspected = 0;
  const bearer: McpBearerCredentialAuthority = {
    createFetch: () => {
      throw new Error('No server is reached in this test.');
    },
    inspect: async () => {
      inspected += 1;
      await gate.promise;
      return { state: 'stored' };
    },
  };
  const { config } = parseMcpConfigValue({
    servers: [
      {
        auth: {
          credential: { id: '00000000-0000-4000-8000-000000000001', store: 'mcp-credentials' },
          type: 'bearer',
        },
        name: 'gated',
        protocol: '2026-07-28',
        startup: 'authentication-required',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      },
    ],
  });
  const collected = Promise.withResolvers<void>();
  const services = await createMcpHostServices({
    appUi: 'text',
    attachElicitationPresenter: () => () => undefined,
    bearerCredentialAuthority: bearer,
    collectCombinedTools: async () => {
      collected.resolve();
      return { mcpDiscoverySkips: [], tools: {} };
    },
    mcpConfiguration: config,
    oauthStore,
    openExternal: async () => undefined,
    openTaskDatabase: async () => {
      throw new Error('No Tasks database is opened in this test.');
    },
    startup: { signal: new AbortController().signal },
  });
  try {
    expect(inspected).toBe(1);
    // A run's discovery waits for the configuration it would otherwise race.
    const selection = services.mcp.executableTools({
      resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
      toolTimeoutMs: 30_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let discovered = false;
    void collected.promise.then(() => {
      discovered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(discovered).toBe(false);
    gate.resolve();
    const selected = await selection;
    expect(selected).toMatchObject({ bindings: {}, unavailable: [] });
    expect(
      services.runtime.host.snapshot().servers.map((server) => server.configuredServerId)
    ).toEqual(['gated']);
    await selected.close();
  } finally {
    gate.resolve();
    await services.close();
  }
});
