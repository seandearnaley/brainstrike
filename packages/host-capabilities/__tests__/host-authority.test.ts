import type { KeyringCredentialBackend } from '@brainstrike/agent-host/credential-contract';
import { expect, test, vi } from 'vitest';
import { createHostAuthority, createHostCredentials } from '../src/index.js';
import { CODEX_TOKEN_URL } from '../src/provider-auth/descriptors/openai-codex.js';
import { toStoredOAuthCredential } from '../src/provider-auth/oauth-flow.js';
import { memoryCredentialBackend } from './fixtures/memory-credential-backend.js';

const PROVIDER = 'openai-codex';

/** An engine-written sign-in whose access token has expired, so the next use refreshes. */
function expiredSignIn(): string {
  return JSON.stringify(
    toStoredOAuthCredential(
      {
        accessToken: 'stored-access-0',
        expiresInSeconds: 1,
        raw: {},
        refreshToken: 'stored-refresh-1',
      },
      { now: Date.now() - 3_600_000 }
    )
  );
}

function hostAuthority(
  options: { readonly failWritesAfterSeed?: boolean; readonly legacyImportPending?: true } = {}
) {
  const memory = memoryCredentialBackend({ [PROVIDER]: expiredSignIn() });
  let writable = true;
  const backend: KeyringCredentialBackend = {
    createEntry: async (request) => {
      const entry = await memory.backend.createEntry(request);
      return {
        ...entry,
        setPassword: async (value) => {
          if (!writable) {
            throw new Error('Recorded keyring write failure');
          }
          await entry.setPassword(value);
        },
      };
    },
    listAccounts: (request) => memory.backend.listAccounts(request),
  };
  if (options.failWritesAfterSeed) {
    writable = false;
  }
  const tokenRequests: URLSearchParams[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url !== CODEX_TOKEN_URL) {
      throw new Error(`Unexpected OAuth request to ${url}`);
    }
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    return Response.json({
      access_token: `refreshed-access-${tokenRequests.length}`,
      expires_in: 3600,
      refresh_token: `rotated-refresh-${tokenRequests.length + 1}`,
      token_type: 'Bearer',
    });
  });
  const credentials = createHostCredentials({
    createNativeBackend: () => backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  const auth = createHostAuthority({
    credentials,
    env: {},
    fetchFn,
    ...(options.legacyImportPending ? { legacyImportPending: true } : {}),
  });
  return { auth, credentials, memory, tokenRequests };
}

test.each([
  ['persisted', false],
  ['held only in memory after a failed write', true],
])('factory reset drops a host-refreshed sign-in (%s)', async (_label, failWritesAfterSeed) => {
  const { auth, credentials, memory, tokenRequests } = hostAuthority({ failWritesAfterSeed });
  try {
    // The host's one refresher rotates the pair; the verdict carries no token.
    await expect(auth.verify(PROVIDER)).resolves.toEqual({ ok: true });
    expect(tokenRequests.map((body) => body.get('refresh_token'))).toEqual(['stored-refresh-1']);
    const stored = memory.entries.get(PROVIDER);
    if (failWritesAfterSeed) {
      // The rotated pair lives only in the refresher's memory overlay.
      expect(stored).toContain('stored-refresh-1');
      await expect(auth.status(PROVIDER)).resolves.toEqual({
        code: 'credential_persist_failed',
        state: 'error',
      });
    } else {
      expect(stored).toContain('rotated-refresh-2');
    }

    await expect(auth.clear()).resolves.toBe(true);

    expect(memory.entries.size).toBe(0);
    await expect(auth.status(PROVIDER)).resolves.toEqual({ state: 'disconnected' });
    await expect(auth.verify(PROVIDER)).resolves.toEqual({ ok: false, status: 'not_connected' });
    // Neither the rotated pair nor the original refresh token is used again.
    expect(tokenRequests).toHaveLength(1);
  } finally {
    await credentials.close();
  }
});

test('Settings writes go through the host authority and a subscription login is refused', async () => {
  const { auth, credentials, memory } = hostAuthority();
  try {
    await auth.setCredential('openai', { key: 'sk-settings-fixture', type: 'api_key' });
    expect(JSON.parse(memory.entries.get('openai') ?? 'null')).toEqual({
      key: 'sk-settings-fixture',
      type: 'api_key',
    });
    await expect(auth.deleteCredential('openai')).resolves.toBe(true);
    expect(memory.entries.has('openai')).toBe(false);
    await expect(
      auth.storeProviderCredential(PROVIDER, { key: 'sk-not-a-sign-in', type: 'api_key' })
    ).rejects.toThrow('does not accept a credential login');
    await expect(auth.connect(PROVIDER, undefined, 'public-socket')).rejects.toThrow(
      /interactive/i
    );
  } finally {
    await credentials.close();
  }
});

/** Settles on the next macrotask with whether `promise` is still pending. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  return !settled;
}

const LEGACY_KEY = JSON.stringify({ key: 'sk-legacy-openrouter', type: 'api_key' });

test("a pending legacy import holds credential use until the desktop's import lands", async () => {
  const { auth, credentials, memory } = hostAuthority({ legacyImportPending: true });
  try {
    const run = auth.resolveProviderAuth('openrouter', 'desktop-ui');
    const status = auth.status(PROVIDER);
    expect(await stillPending(run)).toBe(true);
    expect(await stillPending(status)).toBe(true);

    await expect(
      auth.importLegacy({ entries: [{ account: 'openrouter', value: LEGACY_KEY }] })
    ).resolves.toEqual({ alreadyPresent: 0, migrated: 1 });

    await expect(run).resolves.toEqual({ apiKey: 'sk-legacy-openrouter', kind: 'api_key' });
    await expect(status).resolves.toMatchObject({ state: expect.any(String) });
    expect(memory.entries.get('openrouter')).toBe(LEGACY_KEY);
    // A repeated import (a relaunched host) changes nothing.
    await expect(
      auth.importLegacy({ entries: [{ account: 'openrouter', value: LEGACY_KEY }] })
    ).resolves.toEqual({ alreadyPresent: 1, migrated: 0 });
  } finally {
    await credentials.close();
  }
});

test('an unreadable legacy store fails credential use visibly and factory reset still works', async () => {
  const { auth, credentials, memory } = hostAuthority({ legacyImportPending: true });
  try {
    const status = auth.status(PROVIDER);
    await expect(auth.importLegacy({ unavailable: 'decrypt_failed' })).rejects.toThrow(
      'decrypt_failed'
    );
    await expect(status).rejects.toThrow('decrypt_failed');
    await expect(auth.resolveProviderAuth('openrouter', 'desktop-ui')).rejects.toThrow(
      'decrypt_failed'
    );
    await expect(auth.clear()).resolves.toBe(true);
    expect(memory.entries.size).toBe(0);
  } finally {
    await credentials.close();
  }
});
