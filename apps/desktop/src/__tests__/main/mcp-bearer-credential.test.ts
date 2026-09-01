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
    const baseFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
      return new Response(null, { status: 204 });
    });
    const authority = createSecretsMcpBearerCredentialAuthority({ getKey }, baseFetch);

    await expect(authority.inspect(REFERENCE)).resolves.toEqual({ state: 'stored' });
    await expect(
      authority.createFetch(REFERENCE, 'https://mcp.example.test/resource')(
        'https://mcp.example.test/messages',
        { headers: { 'Mcp-Session-Id': 'session' }, method: 'POST' }
      )
    ).resolves.toMatchObject({ status: 204 });

    expect(getKey).toHaveBeenCalledWith(mcpBearerCredentialStorageKey(REFERENCE));
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(authority)).not.toContain(SECRET);
  });

  it('fails before credential resolution for cross-origin requests or competing auth', async () => {
    const getKey = vi.fn(async () => SECRET);
    const baseFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const authority = createSecretsMcpBearerCredentialAuthority({ getKey }, baseFetch);
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

  it('keeps missing, unreadable, and malformed credential failures secret-free', async () => {
    const cases = [
      { getKey: vi.fn(async () => null), state: 'missing' },
      {
        getKey: vi.fn(async () => {
          throw new Error(`keychain failure carrying ${SECRET}`);
        }),
        state: 'unreadable',
      },
      { getKey: vi.fn(async () => `invalid token ${SECRET}`), state: 'unreadable' },
    ] as const;

    for (const testCase of cases) {
      const authority = createSecretsMcpBearerCredentialAuthority(
        { getKey: testCase.getKey },
        vi.fn(async () => new Response(null, { status: 204 }))
      );
      const inspection = await authority.inspect(REFERENCE);
      expect(inspection.state).toBe(testCase.state);
      expect(JSON.stringify(inspection)).not.toContain(SECRET);

      const failure = await authority
        .createFetch(
          REFERENCE,
          'https://mcp.example.test/resource'
        )('https://mcp.example.test/messages')
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).toMatchObject({
        category: 'authentication',
        code:
          testCase.state === 'missing'
            ? 'mcp-bearer-credential-missing'
            : 'mcp-bearer-credential-unreadable',
      });
      expect(String(failure)).not.toContain(SECRET);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }
  });
});
