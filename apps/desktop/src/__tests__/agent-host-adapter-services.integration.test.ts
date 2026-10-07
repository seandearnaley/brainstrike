// @vitest-environment node
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  createSanitizedToolNameMap,
  resolveAssistantResilienceConfig,
} from '@brainstrike/agent';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { createMcpHostToolAdapter } from '@brainstrike/agent-host';
import {
  createKeyringCredentialStore,
  createKeyringSecretsService,
} from '@brainstrike/agent-host/keyring-credentials';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentHostAdapterCapabilities,
  type AgentHostMcpCollection,
  createAgentHostAdapterServicesFactory,
  createFileCredentialBackend,
  isMcpOAuthCredentialAccount,
} from '../agent-host-platform/adapter-services';
import { createProductionAgentHostAdapterServicesFactory } from '../agent-host-platform/production-adapter-services';
import { mcpBearerCredentialStorageKey } from '../mcp/bearer-credential';
import { createCredentialMcpOAuthStore } from '../mcp/credential-oauth-store';
import {
  createMcpOAuthStoreIdentity,
  identityKey,
  parseRecords,
  purgeMcpOAuthRuntimeState,
} from '../mcp/oauth-client-provider';

const roots = new Set<string>();
const stores = new Set<ReturnType<typeof createKeyringCredentialStore>>();
const oauthStores = new Set<ReturnType<typeof createCredentialMcpOAuthStore>>();
const disposers = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const dispose of [...disposers].reverse()) {
    await dispose();
  }
  disposers.clear();
  for (const oauth of oauthStores) {
    oauth.unregister();
  }
  oauthStores.clear();
  await Promise.all([...stores].map(async (store) => await store.close()));
  stores.clear();
  await Promise.all(
    [...roots].map(async (root) => await rm(root, { force: true, recursive: true }))
  );
  roots.clear();
});

describe('one Node adapter composition', () => {
  it('joins a partially constructed native backend on startup failure without choosing a file fallback', async () => {
    const { root, startup, registered } = await compositionRoot();
    let closed = 0;
    const failure = new Error('Owned fixture policy startup failure.');
    const create = createAgentHostAdapterServicesFactory({
      ...fixtureCapabilities,
      createNativeCredentialBackend: () => ({
        close: async () => {
          closed += 1;
        },
        createEntry: async () => {
          throw new Error('No native credential read was expected.');
        },
        listAccounts: async () => [],
      }),
      createProviderCredentialReader: () => {
        throw failure;
      },
    });
    await expect(
      create({
        appUi: 'text',
        credentialStore: { kind: 'keyring', service: 'owned-disposable-fixture' },
        mcpConfiguration: { servers: [] },
        openExternal: async () => undefined,
        openTaskDatabase: async () => {
          throw new Error('No database expected.');
        },
        root,
        startup,
      })
    ).rejects.toBe(failure);
    expect(closed).toBe(1);
    await registered[0]?.();
    expect(closed).toBe(1);
    await expect(stat(join(root, 'explicit-credentials.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('joins held discovery and fences late diagnostics when root shutdown begins', async () => {
    const { root, startup } = await compositionRoot();
    const entered = Promise.withResolvers<void>();
    const collected = Promise.withResolvers<AgentHostMcpCollection>();
    let published = 0;
    const services = await createAgentHostAdapterServicesFactory({
      ...fixtureCapabilities,
      collectCombinedTools: () => {
        entered.resolve();
        return collected.promise;
      },
      onMcpDiscoverySkips: async () => {
        published += 1;
      },
    })({
      appUi: 'text',
      credentialStore: { kind: 'file', path: join(root, 'explicit-credentials.json') },
      mcpConfiguration: { servers: [] },
      openExternal: async () => undefined,
      openTaskDatabase: async () => {
        throw new Error('No database expected.');
      },
      root,
      startup,
    });
    try {
      const discovery = services.mcp.executableTools();
      const rejected = expect(discovery).rejects.toMatchObject({
        code: 'agent_host_adapter_closed',
      });
      await entered.promise;
      let joined = false;
      const close = services.close().then(() => {
        joined = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
      collected.resolve({ mcpDiscoverySkips: [], tools: {} });
      await rejected;
      await close;
      expect(published).toBe(0);
      expect(joined).toBe(true);
    } finally {
      collected.resolve({ mcpDiscoverySkips: [], tools: {} });
      await services.close();
    }
  });

  it('shares the selected file authority with Settings and provider auth without starting desktop defaults', async () => {
    const { root, startup, registered } = await compositionRoot();
    const openTaskDatabase = async (): Promise<never> => {
      throw new Error('No second Tasks writer may be constructed.');
    };
    const services = await createAgentHostAdapterServicesFactory(fixtureCapabilities)({
      appUi: 'text',
      credentialStore: { kind: 'file', path: join(root, 'explicit-credentials.json') },
      mcpConfiguration: { servers: [] },
      openExternal: async () => {
        throw new Error('No opener request was expected.');
      },
      openTaskDatabase,
      root,
      startup,
    });
    disposers.add(services.close);
    expect(registered).toHaveLength(1);
    expect(services.mcp.authority).toBe(services.runtime.host);
    await services.secrets.saveKey('openai', 'owned-composed-key');
    await expect(services.resolveProviderAuth('openai')).resolves.toEqual({
      apiKey: 'owned-composed-key',
      kind: 'api_key',
    });
    await services.secrets.setCredential('bedrock', {
      mode: 'profile_chain',
      region: 'us-east-1',
      type: 'aws',
    });
    await expect(services.resolveProviderAuth('bedrock')).rejects.toMatchObject({
      code: 'credential_type_unsupported',
    });
    await expect(services.mcp.executableTools()).resolves.toEqual({});
    const close = services.close();
    expect(registered[0]?.()).toBe(close);
    await close;
    await expect(services.readProviderCredential('openai')).rejects.toMatchObject({
      code: 'agent_host_adapter_closed',
    });
    await expect(services.secrets.saveKey('openai', 'late-owned-key')).rejects.toMatchObject({
      code: 'agent_host_adapter_closed',
    });
  });

  it.each(['rich', 'text'] as const)(
    'executes the existing HTTP authority once and fences retired bindings (%s Apps)',
    async (appUi) => {
      const { root, startup } = await compositionRoot();
      const server = await startStatefulMcpHostServer();
      disposers.add(server.close);
      const internalErrors: string[] = [];
      const services = await createProductionAgentHostAdapterServicesFactory({
        ...fixtureCapabilities,
        runtimeDependencies: {
          onInternalError: (code) => {
            internalErrors.push(code);
          },
        },
      })({
        appUi,
        credentialStore: { kind: 'file', path: join(root, 'explicit-credentials.json') },
        mcpConfiguration: { servers: [] },
        openExternal: async () => {
          throw new Error('No opener request was expected.');
        },
        openTaskDatabase: async () => {
          throw new Error('No Tasks database was requested by this legacy fixture.');
        },
        root,
        startup,
      });
      disposers.add(services.close);
      const credential = {
        id: '00000000-0000-4000-8000-000000000001',
        store: 'mcp-credentials',
      } as const;
      await services.secrets.saveKey(
        mcpBearerCredentialStorageKey(credential),
        'owned-local-bearer'
      );
      await services.runtime.replaceResolvedConfig({
        servers: [
          {
            auth: { credential, type: 'bearer' },
            name: parseConfiguredMcpServerId('fixture.composed'),
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      });
      const bindings = await services.mcp.executableTools();
      expect(Object.keys(bindings)).toHaveLength(1);
      const [name, binding] = Object.entries(bindings)[0]!;
      expect(binding.configuredServerId).toBe('fixture.composed');
      expect(binding.tool.identity).toBe(
        JSON.stringify([
          'fixture.composed',
          binding.generation,
          'fixture_composed_host_lifecycle_probe',
        ])
      );
      const adapter = createMcpHostToolAdapter({ bindings, host: services.mcp.authority });
      disposers.add(adapter.close);
      await expect(
        adapter.tools[name]!.execute(
          {},
          {
            runId: 'owned-run',
            signal: new AbortController().signal,
            threadId: 'owned-thread',
            toolCallId: 'owned-tool-call',
          }
        )
      ).resolves.toEqual({ content: [{ text: 'ok', type: 'text' }] });
      const initialized = server.requests.filter(
        ({ body }) =>
          body && typeof body === 'object' && 'method' in body && body.method === 'initialize'
      );
      expect(initialized).toHaveLength(1);
      expect(
        server.requests.every(({ authorization }) => authorization === 'Bearer owned-local-bearer')
      ).toBe(true);
      const current = services.runtime.host.snapshot().servers[0];
      expect(current?.extensions?.apps).toBe(appUi === 'rich');
      await services.runtime.replaceResolvedConfig({ servers: [] });
      await expect(
        adapter.tools[name]!.execute(
          {},
          {
            runId: 'owned-run',
            signal: new AbortController().signal,
            threadId: 'owned-thread',
            toolCallId: 'retired-tool-call',
          }
        )
      ).rejects.toMatchObject({ category: 'generation-retired' });
      const calls = server.requests.filter(
        ({ body }) =>
          body && typeof body === 'object' && 'method' in body && body.method === 'tools/call'
      );
      expect(calls).toHaveLength(1);
      const report = await services.mcp.close();
      expect(report.failures).toEqual([]);
      expect(report.clientsClosed).toBe(1);
      expect(internalErrors).toEqual([]);
    }
  );

  it('registers ownership before native construction and retains actual read completion and backend exit', async () => {
    const { root, startup, registered } = await compositionRoot();
    const reading = Promise.withResolvers<void>();
    const nativeRead = Promise.withResolvers<string>();
    const exiting = Promise.withResolvers<void>();
    const nativeExit = Promise.withResolvers<void>();
    const services = await createAgentHostAdapterServicesFactory({
      ...fixtureCapabilities,
      createNativeCredentialBackend: () => {
        expect(registered).toHaveLength(1);
        return {
          close: () => {
            exiting.resolve();
            return nativeExit.promise;
          },
          createEntry: async () => ({
            deleteCredential: async () => false,
            getPassword: () => {
              reading.resolve();
              return nativeRead.promise;
            },
            setPassword: async () => undefined,
          }),
          listAccounts: async () => [],
        };
      },
    })({
      appUi: 'text',
      credentialStore: { kind: 'keyring', service: 'owned-disposable-fixture' },
      mcpConfiguration: { servers: [] },
      openExternal: async () => undefined,
      openTaskDatabase: async () => {
        throw new Error('No database expected.');
      },
      root,
      startup,
    });
    try {
      const read = services.readProviderCredential('openai');
      const rejected = expect(read).rejects.toMatchObject({ code: 'agent_host_adapter_closed' });
      await reading.promise;
      let closed = false;
      const close = services.close().then(() => {
        closed = true;
      });
      await expect(services.secrets.getKey('openai')).rejects.toMatchObject({
        code: 'agent_host_adapter_closed',
      });
      expect(closed).toBe(false);
      nativeRead.resolve(JSON.stringify({ key: 'owned-native-fixture', type: 'api_key' }));
      await rejected;
      await exiting.promise;
      expect(closed).toBe(false);
      nativeExit.resolve();
      await close;
      expect(closed).toBe(true);
    } finally {
      nativeRead.resolve(JSON.stringify({ key: 'owned-native-fixture', type: 'api_key' }));
      nativeExit.resolve();
      await services.close();
    }
  });
});

// A fixture collector exercises real canonical executors through the injected
// port. Settings/result-limit policy remains the shipped collector's suite;
// production must inject that collector when Studio publishes its public export.
const fixtureCapabilities: AgentHostAdapterCapabilities<AgentHostMcpCollection> = {
  attachElicitationPresenter: (presenter) =>
    presenter.attach(() => {
      throw new Error('This fixture did not request an elicitation.');
    }),
  collectCombinedTools: async ({ mcpClient, toolNameMap }) => {
    const discovered = await mcpClient?.listToolsetsWithErrors();
    expect(discovered?.errors ?? {}).toEqual({});
    const namespaced = Object.fromEntries(
      Object.entries(discovered?.toolsets ?? {}).flatMap(([server, tools]) =>
        Object.entries(tools).map(([name, tool]) => [`${server}.${name}`, tool])
      )
    );
    const names = createSanitizedToolNameMap(Object.keys(namespaced));
    for (const [name, canonicalId] of names) {
      toolNameMap.set(name, canonicalId);
    }
    return {
      mcpDiscoverySkips: [],
      tools: Object.fromEntries([...names].map(([name, id]) => [name, namespaced[id]!])),
    };
  },
  createProviderCredentialReader: (secrets) => async (provider) => {
    const credential = await secrets.getCredential(provider);
    return credential ? { ...credential, source: 'stored' } : undefined;
  },
  onMcpDiscoverySkips: async (skips) => {
    expect(skips).toEqual([]);
  },
  resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
  toolTimeoutMs: resolveAssistantResilienceConfig().toolTimeoutMs,
};

async function compositionRoot() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-adapters-owned-'));
  roots.add(root);
  const store = await StateStore.open(root);
  disposers.add(() => store.close());
  const registered: (() => Promise<void>)[] = [];
  return {
    registered,
    root,
    startup: {
      register: async (close: () => Promise<void>) => {
        registered.push(close);
      },
      signal: new AbortController().signal,
      store,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-credentials-owned-'));
  roots.add(root);
  const path = join(root, 'explicit-credentials.json');
  const credentials = createKeyringCredentialStore({
    backend: createFileCredentialBackend(path),
    service: resolve(path),
  });
  stores.add(credentials);
  const secrets = createKeyringSecretsService({
    accountForProvider: (provider) => provider,
    credentials,
    providerForAccount: (account) => (isMcpOAuthCredentialAccount(account) ? undefined : account),
  });
  const oauth = createCredentialMcpOAuthStore({
    accountForIdentity: identityKey,
    credentials,
    ownsAccount: isMcpOAuthCredentialAccount,
    parseRecords,
  });
  oauthStores.add(oauth);
  return { credentials, oauth, path, root, secrets };
}

describe('explicit private credential file backend', () => {
  it('creates only on mutation and preserves canonical provider and OAuth account keys', async () => {
    const { credentials, oauth, path, root, secrets } = await fixture();
    await expect(secrets.getCredential('absent')).resolves.toBeNull();
    expect(await readdir(root)).toEqual([]);
    const identity = createMcpOAuthStoreIdentity('fixture.file', 'https://mcp.example.test/mcp', [
      'read',
    ]);
    const records = { 'https://auth.example.test': { loopbackPort: 43_123, updatedAt: 123 } };
    await Promise.all([
      secrets.saveKey('openai', 'owned-fixture-key'),
      oauth.write(identity, records),
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toEqual({
      records: { [identityKey(identity)]: JSON.stringify(records) },
      secrets: { openai: JSON.stringify({ key: 'owned-fixture-key', type: 'api_key' }) },
      version: 1,
    });
    expect(await readdir(root)).toEqual(['explicit-credentials.json']);
    await credentials.close();
    const reopened = createKeyringCredentialStore({
      backend: createFileCredentialBackend(path),
      service: path,
    });
    stores.add(reopened);
    await expect(reopened.read('openai')).resolves.toBe(
      JSON.stringify({ key: 'owned-fixture-key', type: 'api_key' })
    );
    await expect(reopened.read(identityKey(identity))).resolves.toBe(JSON.stringify(records));
  });

  it('retains the existing MCP reset boundary and keeps provider clearing separate', async () => {
    const { oauth, secrets } = await fixture();
    const identity = createMcpOAuthStoreIdentity('fixture.file', 'https://mcp.example.test/mcp');
    const records = { 'https://auth.example.test': { updatedAt: 123 } };
    await secrets.saveKey('openai', 'owned-fixture-key');
    await oauth.write(identity, records);
    await purgeMcpOAuthRuntimeState();
    await expect(oauth.read(identity)).resolves.toEqual({});
    await expect(secrets.getKey('openai')).resolves.toBe('owned-fixture-key');
    await oauth.write(identity, records);
    await expect(secrets.clearAll()).resolves.toBe(true);
    await expect(oauth.read(identity)).resolves.toEqual(records);
  });

  it.each([0o644, 0o400, 0o700])(
    'refuses existing mode %i without changing contents or permissions',
    async (mode) => {
      const { credentials, path, secrets } = await fixture();
      const raw = JSON.stringify({ records: {}, secrets: {}, version: 1 });
      await writeFile(path, raw, { mode: 0o600 });
      await chmod(path, mode);
      await expect(secrets.getCredential('openai')).rejects.toMatchObject({
        code: 'decrypt_failed',
        name: 'SecretReadError',
      });
      await expect(credentials.write('openai', 'owned-fixture-key')).rejects.toMatchObject({
        code: 'credential_store_unavailable',
      });
      expect(await readFile(path, 'utf8')).toBe(raw);
      expect((await stat(path)).mode & 0o777).toBe(mode);
    }
  );

  it.each([
    '{',
    JSON.stringify({ secrets: { openai: 'legacy-encrypted-fixture' } }),
    JSON.stringify({ records: {}, secrets: {}, version: 2 }),
    JSON.stringify({ records: { openai: '{}' }, secrets: {}, version: 1 }),
    JSON.stringify({ records: {}, secrets: {}, unknown: true, version: 1 }),
  ])(
    'leaves malformed and legacy files untouched instead of migrating or falling back',
    async (raw) => {
      const { credentials, path } = await fixture();
      await writeFile(path, raw, { mode: 0o600 });
      await expect(credentials.read('openai')).rejects.toMatchObject({
        code: 'credential_store_unavailable',
      });
      await expect(credentials.write('openai', 'owned-fixture-key')).rejects.toMatchObject({
        code: 'credential_store_unavailable',
      });
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  );

  it('refuses a credential symlink and leaves its target untouched', async () => {
    const { credentials, path, root } = await fixture();
    const target = join(root, 'owned-target.json');
    const raw = JSON.stringify({ records: {}, secrets: {}, version: 1 });
    await writeFile(target, raw, { mode: 0o600 });
    await symlink(target, path);
    await expect(credentials.read('openai')).rejects.toMatchObject({
      code: 'credential_store_unavailable',
    });
    await expect(credentials.write('openai', 'owned-fixture-key')).rejects.toMatchObject({
      code: 'credential_store_unavailable',
    });
    expect(await readFile(target, 'utf8')).toBe(raw);
  });

  it('requires the explicitly selected absolute file identity', () => {
    expect(() => createFileCredentialBackend('relative-profile.json')).toThrow(TypeError);
  });

  it('classifies corrupt JSON without retaining parser exceptions containing credential bytes', async () => {
    const { credentials, path } = await fixture();
    const marker = 'owned-disposable-secret-marker';
    await writeFile(path, marker, { mode: 0o600 });
    const failure: unknown = await credentials.read('openai').catch((error: unknown) => error);
    expect(failure).toMatchObject({
      cause: { code: 'credential_file_malformed', name: 'CredentialFileFormatError' },
      code: 'credential_store_unavailable',
    });
    expect(JSON.stringify(failure)).not.toContain(marker);
  });
});
