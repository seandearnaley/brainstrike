import { describe, expect, it } from 'vitest';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
} from '../../mcp/oauth-client-provider.js';

describe('MCP OAuth authorization-server migration', () => {
  it('forces fresh discovery after a stored bearer token is rejected', async () => {
    const provider = await createMcpOAuthClientProvider({
      openExternal: async () => undefined,
      serverId: 'authorization-server-migration',
      serverUrl: 'https://mcp.example.test/mcp',
      store: createInMemoryMcpOAuthStore(),
    });
    if (!(provider.saveClientInformation && provider.saveDiscoveryState && provider.saveTokens)) {
      throw new Error('Production OAuth provider does not expose migration persistence methods.');
    }
    const as1 = 'https://auth-one.example.test';
    const as2 = 'https://auth-two.example.test';
    const discovery = { authorizationServerUrl: as1 };
    try {
      await provider.saveDiscoveryState(discovery);
      await provider.saveClientInformation(
        { client_id: 'as-one-client', issuer: as1 },
        { issuer: as1 }
      );
      await provider.saveTokens(
        { access_token: 'as-one-token', issuer: as1, token_type: 'Bearer' },
        { issuer: as1 }
      );

      await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'as-one-token' });
      await expect(provider.discoveryState?.()).resolves.toBeUndefined();
      await provider.saveDiscoveryState({ authorizationServerUrl: as2 });

      await expect(provider.clientInformation({ issuer: as2 })).resolves.toBeUndefined();
      await expect(provider.clientInformation({ issuer: as1 })).resolves.toMatchObject({
        client_id: 'as-one-client',
      });
    } finally {
      await provider.close();
    }
  });

  it('retains discovery state on the authorization callback leg before any bearer use', async () => {
    const provider = await createMcpOAuthClientProvider({
      openExternal: async () => undefined,
      serverId: 'authorization-callback-binding',
      serverUrl: 'https://mcp.example.test/mcp',
      store: createInMemoryMcpOAuthStore(),
    });
    const discovery = { authorizationServerUrl: 'https://auth.example.test' };
    if (!provider.saveDiscoveryState) {
      throw new Error('Production OAuth provider does not expose discovery persistence.');
    }
    try {
      await provider.saveDiscoveryState(discovery);
      await expect(provider.discoveryState?.()).resolves.toEqual(discovery);
    } finally {
      await provider.close();
    }
  });
});
