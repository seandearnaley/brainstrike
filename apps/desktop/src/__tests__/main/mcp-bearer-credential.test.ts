import { describe, expect, it, vi } from 'vitest';
import {
  createSecretsMcpBearerCredentialAuthority,
  mcpBearerCredentialStorageKey,
} from '../../mcp/bearer-credential';

const REFERENCE = {
  id: '00000000-0000-4000-8000-000000000001',
  store: 'mcp-credentials',
} as const;
const SECRET = 'bst-bearer-secret-sentinel';

describe('MCP external bearer credential authority', () => {
  it('injects the resolved bearer only into same-origin owned transport requests', async () => {
    const getKey = vi.fn(async (key: string) =>
      key === 'mcp-credentials:00000000-0000-4000-8000-000000000001' ? SECRET : null
    );
    const listProviders = vi.fn(async () => [mcpBearerCredentialStorageKey(REFERENCE)]);
    const baseFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
      return new Response(null, { status: 204 });
    });
    const authority = createSecretsMcpBearerCredentialAuthority(
      { getKey, listProviders },
      baseFetch
    );

    await expect(authority.inspect(REFERENCE)).resolves.toEqual({ state: 'stored' });
    expect(getKey).not.toHaveBeenCalled();
    await expect(
      authority.createFetch(REFERENCE, 'https://mcp.example.test/resource')(
        'https://mcp.example.test/messages',
        { headers: { 'Mcp-Session-Id': 'session' }, method: 'POST' }
      )
    ).resolves.toMatchObject({ status: 204 });

    expect(getKey).toHaveBeenCalledWith(mcpBearerCredentialStorageKey(REFERENCE));
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(authority)).not.toContain(SECRET);
  });

  it('fails before credential resolution for cross-origin requests or competing auth', async () => {
    const getKey = vi.fn(async () => SECRET);
    const baseFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const authority = createSecretsMcpBearerCredentialAuthority(
      { getKey, listProviders: vi.fn(async () => [mcpBearerCredentialStorageKey(REFERENCE)]) },
      baseFetch
    );
    const credentialFetch = authority.createFetch(REFERENCE, 'https://mcp.example.test/resource');

    await expect(credentialFetch('https://attacker.example/messages')).rejects.toMatchObject({
      code: 'mcp-bearer-origin-mismatch',
    });
    await expect(
      credentialFetch('https://mcp.example.test/messages', {
        headers: { authorization: 'Bearer competing-secret' },
      })
    ).rejects.toMatchObject({ code: 'mcp-bearer-authorization-conflict' });
    expect(getKey).not.toHaveBeenCalled();
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('inspects credential presence without decrypting the token', async () => {
    const getKey = vi.fn(async () => SECRET);
    const authority = createSecretsMcpBearerCredentialAuthority({
      getKey,
      listProviders: vi.fn(async () => []),
    });

    await expect(authority.inspect(REFERENCE)).resolves.toEqual({ state: 'missing' });
    expect(getKey).not.toHaveBeenCalled();
  });

  it('keeps missing, unreadable, and malformed credential failures distinct and secret-free', async () => {
    const cases = [
      { code: 'mcp-bearer-credential-missing', getKey: vi.fn(async () => null) },
      {
        code: 'mcp-bearer-credential-unreadable',
        getKey: vi.fn(async () => {
          throw new Error(`keychain failure carrying ${SECRET}`);
        }),
      },
      {
        code: 'mcp-bearer-credential-malformed',
        getKey: vi.fn(async () => `invalid token ${SECRET}`),
      },
    ] as const;

    for (const testCase of cases) {
      const observedStates: string[] = [];
      const authority = createSecretsMcpBearerCredentialAuthority(
        {
          getKey: testCase.getKey,
          listProviders: vi.fn(async () => [mcpBearerCredentialStorageKey(REFERENCE)]),
        },
        vi.fn(async () => new Response(null, { status: 204 }))
      );
      const inspection = await authority.inspect(REFERENCE);
      expect(inspection.state).toBe('stored');
      expect(JSON.stringify(inspection)).not.toContain(SECRET);

      const failure = await authority
        .createFetch(REFERENCE, 'https://mcp.example.test/resource', (state) =>
          observedStates.push(state)
        )('https://mcp.example.test/messages')
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).toMatchObject({
        category: 'authentication',
        code: testCase.code,
      });
      expect(observedStates).toEqual([
        testCase.code === 'mcp-bearer-credential-missing'
          ? 'missing'
          : testCase.code === 'mcp-bearer-credential-malformed'
            ? 'malformed'
            : 'unreadable',
      ]);
      expect(String(failure)).not.toContain(SECRET);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }
  });

  it('rejects an invalid resource URL with a fixed credential code', () => {
    const authority = createSecretsMcpBearerCredentialAuthority({
      getKey: vi.fn(async () => SECRET),
      listProviders: vi.fn(async () => [mcpBearerCredentialStorageKey(REFERENCE)]),
    });

    expect(() => authority.createFetch(REFERENCE, 'not a URL')).toThrow(
      expect.objectContaining({ code: 'mcp-bearer-origin-mismatch' })
    );
  });
});
