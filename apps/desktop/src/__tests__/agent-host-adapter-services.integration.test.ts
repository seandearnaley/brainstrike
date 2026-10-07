// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  createSanitizedToolNameMap,
  resolveAssistantResilienceConfig,
  resolveToolResultBudgetForModel,
} from '@brainstrike/agent';
import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import {
  createMcpHostToolAdapter,
  createProductionHostPlatform,
  HostCore,
} from '@brainstrike/agent-host';
import {
  createKeyringCredentialStore,
  createKeyringSecretsService,
} from '@brainstrike/agent-host/keyring-credentials';
import {
  scriptedModel,
  scriptedToolSequence,
} from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentHostAdapterCapabilities,
  type AgentHostMcpCollection,
  createAgentHostAdapterServicesFactory,
  createFileCredentialBackend,
  isMcpOAuthCredentialAccount,
} from '../agent-host-platform/adapter-services';
import { writePrivateCredentialFile } from '../agent-host-platform/private-credential-file';
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

const WindowsFilePrivacySchema = z.object({
  current: z.string(),
  owner: z.string(),
  protected: z.boolean(),
  rules: z.array(
    z.object({
      inheritance: z.number(),
      inherited: z.boolean(),
      propagation: z.number(),
      rights: z.number(),
      sid: z.string(),
      type: z.string(),
    })
  ),
});
type FilePrivacy =
  | { readonly kind: 'posix'; readonly mode: number }
  | ({ readonly kind: 'windows' } & z.output<typeof WindowsFilePrivacySchema>);
type WindowsPrivacyMutation = 'extra-principal' | 'insufficient-rights' | 'unprotected';

async function filePrivacy(path: string, mutation?: WindowsPrivacyMutation): Promise<FilePrivacy> {
  if (process.platform !== 'win32') {
    return { kind: 'posix', mode: (await stat(path)).mode & 0o777 };
  }
  // Independent OS inspection of only this disposable fixture, not the native
  // verifier being tested. Secret bytes and user Keychain state are not read.
  const command = `
$ErrorActionPreference = 'Stop'
$info = [System.IO.FileInfo]::new($env:BS_M3_CREDENTIAL_FILE)
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$acl = $info.GetAccessControl($sections)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
switch ($env:BS_M3_CREDENTIAL_MUTATION) {
 'extra-principal' { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow)) }
 'insufficient-rights' { $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow)) }
 'unprotected' { $acl.SetAccessRuleProtection($false,$true) }
}
if ($env:BS_M3_CREDENTIAL_MUTATION) { $info.SetAccessControl($acl); $acl = $info.GetAccessControl($sections) }
$rules = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [ordered]@{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags; type=$_.AccessControlType.ToString() } })
[ordered]@{ owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=$sid.Value; protected=$acl.AreAccessRulesProtected; rules=@($rules) } | ConvertTo-Json -Depth 4 -Compress
`;
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      env: {
        ...process.env,
        BS_M3_CREDENTIAL_FILE: path,
        BS_M3_CREDENTIAL_MUTATION: mutation ?? '',
      },
      windowsHide: true,
    }
  );
  return { kind: 'windows', ...WindowsFilePrivacySchema.parse(JSON.parse(stdout)) };
}

async function expectPrivateFile(path: string): Promise<void> {
  const privacy = await filePrivacy(path);
  if (privacy.kind === 'posix') {
    expect(privacy.mode).toBe(0o600);
    return;
  }
  expect(privacy).toEqual({
    current: privacy.current,
    kind: 'windows',
    owner: privacy.current,
    protected: true,
    rules: [
      {
        inheritance: 0,
        inherited: false,
        propagation: 0,
        rights: 2_032_127,
        sid: privacy.current,
        type: 'Allow',
      },
    ],
  });
}
const memoryCalculatorModule = fileURLToPath(
  new URL('./adapters/memory-storage-calculator.js', import.meta.resolve('@brainstrike/agent-host'))
);
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

async function releaseCredentialFifoReader(path: string): Promise<void> {
  try {
    const writer = await open(
      path,
      constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    await writer.close();
  } catch (error) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENXIO')
    ) {
      throw error;
    }
  }
}

describe('one Node adapter composition', () => {
  it('refuses a persisted MCP approval when the same named server points to another authority after restart', async () => {
    const { root, startup } = await compositionRoot(true);
    const first = await startStatefulMcpHostServer();
    const replacement = await startStatefulMcpHostServer();
    disposers.add(first.close);
    disposers.add(replacement.close);
    let store = startup.store;
    const openPlatform = async (url: string) => {
      const services = await createAgentHostAdapterServicesFactory(fixtureCapabilities)({
        appUi: 'text',
        credentialStore: { kind: 'file', path: join(root, 'explicit-credentials.json') },
        mcpConfiguration: {
          servers: [
            {
              name: parseConfiguredMcpServerId('fixture.restarted'),
              protocol: 'legacy',
              startup: 'automatic',
              transport: 'streamable-http',
              url,
            },
          ],
        },
        openExternal: async () => undefined,
        openTaskDatabase: async () => {
          throw new Error('No Tasks database expected by this legacy fixture');
        },
        root,
        startup: { ...startup, store },
      });
      disposers.add(services.close);
      const selected = await services.mcp.executableTools(fixtureToolRequest);
      const name = Object.keys(selected.bindings)[0];
      if (!name) {
        throw new Error('The real fixture MCP catalog is empty');
      }
      await selected.close();
      return createProductionHostPlatform({
        close: services.close,
        mcp: services.mcp,
        readConfiguration: async () => ({
          configuration: { model: 'fixture', provider: 'openai' },
          durableConfiguration: { model: 'fixture', provider: 'openai' },
          maxSteps: 3,
          memory: {
            native: { options: { observationalMemory: false, semanticRecall: false } },
            recordPrompt: async () => undefined,
            resourceId: 'workspace',
          },
          providerRequestContext: { inputTokenLimit: 30_000, provider: 'openai' },
          resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
          tools: {},
          toolTimeoutMs: fixtureToolRequest.toolTimeoutMs,
        }),
        readPermissionPolicy: () => ({
          policies: { ...DEFAULT_PERMISSION_POLICIES, mcp: 'ask' },
          yolo: false,
        }),
        resolveModel: async () => scriptedToolSequence([{ input: {}, toolId: name }]),
        resolveProviderAuth: async () => undefined,
        startup: { ...startup, store },
      });
    };
    let core = await HostCore.open(store, await openPlatform(first.url), () => () => undefined);
    const failures: unknown[] = [];
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId: 'fixture',
        prompt: 'Call the configured MCP probe',
        threadId,
      });
      let interactionId: string | undefined;
      await expect
        .poll(async () => {
          const event = (await core.read(threadId, 0)).find(
            ({ event }) => event.type === 'interaction.requested'
          )?.event;
          if (event?.type === 'interaction.requested') {
            interactionId = event.interactionId;
          }
          return interactionId !== undefined;
        })
        .toBe(true);
      if (!interactionId) {
        throw new Error('The real MCP call did not require approval');
      }
      await core.close();
      await store.close();
      store = await StateStore.open(root, { memoryCalculatorModule });
      disposers.add(() => store.close());
      core = await HostCore.open(store, await openPlatform(replacement.url), () => () => undefined);
      let refusal: unknown;
      try {
        await core.respond({
          commandId: randomUUID(),
          decision: 'approve',
          interactionId,
          runId,
          threadId,
        });
      } catch (cause) {
        refusal = cause;
      }
      if (!refusal) {
        await expect
          .poll(async () =>
            (await core.read(threadId, 0)).some(({ event }) => event.type === 'run.finished')
          )
          .toBe(true);
      }
      const calls = replacement.requests.filter(
        ({ body }) => z.object({ method: z.literal('tools/call') }).safeParse(body).success
      );
      expect(calls).toHaveLength(0);
      expect(refusal).toBeInstanceOf(Error);
    } catch (cause) {
      failures.push(cause);
    }
    const cleanup = await Promise.allSettled([core.close()]);
    cleanup.push(...(await Promise.allSettled([store.close()])));
    failures.push(
      ...cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason)
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'MCP restart assertion and cleanup failed');
    }
  });
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
      const discovery = services.mcp.executableTools(fixtureToolRequest);
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
    const selection = await services.mcp.executableTools(fixtureToolRequest);
    expect(selection.bindings).toEqual({});
    await selection.close();
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
      const selection = await services.mcp.executableTools(fixtureToolRequest);
      const { bindings } = selection;
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
      expect(binding.tool.permissionToolId).toBe('fixture.composed.host_lifecycle_probe');
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
      await adapter.close();
      await selection.close();
      const report = await services.mcp.close();
      expect(report.failures).toEqual([]);
      expect(report.clientsClosed).toBe(1);
      expect(internalErrors).toEqual([]);
    }
  );

  it('joins each admission borrow while retaining one HTTP authority and immutable model budgets', async () => {
    const { root, startup } = await compositionRoot();
    const server = await startStatefulMcpHostServer();
    disposers.add(server.close);
    const entered = Promise.withResolvers<void>();
    const releaseDiscovery = Promise.withResolvers<void>();
    const observedBudgets: number[] = [];
    const small = { ...resolveToolResultBudgetForModel('ollama', 'runtime-observed-model') };
    const large = { ...resolveToolResultBudgetForModel('openai', 'gpt-5.4') };
    const originalSmall = small.transportResultTokens;
    const services = await createAgentHostAdapterServicesFactory({
      ...fixtureCapabilities,
      collectCombinedTools: async (options) => {
        observedBudgets.push(options.scaledDefaultTokens);
        if (observedBudgets.length === 1) {
          entered.resolve();
          await releaseDiscovery.promise;
        }
        return collectCombinedTools(options);
      },
    })({
      appUi: 'text',
      credentialStore: { kind: 'file', path: join(root, 'explicit-credentials.json') },
      mcpConfiguration: {
        servers: [
          {
            name: parseConfiguredMcpServerId('fixture.bounded'),
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      },
      openExternal: async () => undefined,
      openTaskDatabase: async () => {
        throw new Error('No Tasks database expected.');
      },
      root,
      startup,
    });
    disposers.add(services.close);
    let watches = 0;
    const watch = services.mcp.authority.watch.bind(services.mcp.authority);
    const observeWatch = vi
      .spyOn(services.mcp.authority, 'watch')
      .mockImplementation((filter, listener) => {
        const unwatch = watch(filter, listener);
        watches += 1;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            unwatch();
            watches -= 1;
          }
        };
      });
    const platform = await createProductionHostPlatform({
      close: services.close,
      mcp: services.mcp,
      readConfiguration: async (request) => ({
        configuration: { model: request.modelId, provider: 'openai' },
        durableConfiguration: { model: request.modelId, provider: 'openai' },
        maxSteps: 1,
        memory: {
          native: { options: { observationalMemory: false, semanticRecall: false } },
          recordPrompt: async () => undefined,
          resourceId: 'owned-resource',
        },
        providerRequestContext: { inputTokenLimit: 30_000, provider: 'openai' },
        resolvedToolResultBudget: request.modelId === 'small' ? small : large,
        tools: {},
        toolTimeoutMs: fixtureToolRequest.toolTimeoutMs,
      }),
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => scriptedModel(),
      resolveProviderAuth: async () => undefined,
      startup,
    });
    disposers.add(platform.close);
    const admit = (modelId: string) =>
      platform.admitRun!({
        modelId,
        signal: new AbortController().signal,
        threadId: 'owned-thread',
      });
    try {
      const first = admit('small');
      await entered.promise;
      small.transportResultTokens = large.transportResultTokens;
      const second = await admit('large');
      releaseDiscovery.resolve();
      const initial = await first;
      expect(observedBudgets).toEqual([originalSmall, large.transportResultTokens]);
      expect(originalSmall).toBeLessThan(large.transportResultTokens);
      expect(watches).toBe(4);
      await initial.close?.();
      expect(watches).toBe(2);
      await second.close?.();
      expect(watches).toBe(0);
      for (let run = 0; run < 3; run += 1) {
        const selection = await admit('large');
        expect(watches).toBe(2);
        const tool = Object.values(selection.tools)[0]!;
        await expect(
          tool.execute(
            {},
            {
              runId: `owned-run-${run}`,
              signal: new AbortController().signal,
              threadId: 'owned-thread',
              toolCallId: `owned-call-${run}`,
            }
          )
        ).resolves.toEqual({ content: [{ text: 'ok', type: 'text' }] });
        await selection.close?.();
        await selection.close?.();
        expect(watches).toBe(0);
      }
      expect(
        server.requests.filter(
          ({ body }) =>
            body && typeof body === 'object' && 'method' in body && body.method === 'initialize'
        )
      ).toHaveLength(1);
      expect(server.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
      expect(services.mcp.authority.snapshot().servers[0]?.state).toBe('connected');
      await platform.close();
      expect(watches).toBe(0);
      expect(server.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
    } finally {
      releaseDiscovery.resolve();
      await platform.close();
      observeWatch.mockRestore();
    }
  });

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
};

const fixtureToolRequest = {
  resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
  toolTimeoutMs: resolveAssistantResilienceConfig().toolTimeoutMs,
};

async function compositionRoot(memory = false) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-adapters-owned-'));
  roots.add(root);
  const store = await StateStore.open(root, memory ? { memoryCalculatorModule } : undefined);
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
    await expectPrivateFile(path);
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

  it.each([
    { mode: 0o644, mutation: 'extra-principal' },
    { mode: 0o400, mutation: 'insufficient-rights' },
    { mode: 0o700, mutation: 'unprotected' },
  ] as const)(
    'refuses a nonprivate file ($mode / $mutation) without changing contents or permissions',
    async ({ mode, mutation }) => {
      const { credentials, path, secrets } = await fixture();
      const raw = JSON.stringify({ records: {}, secrets: {}, version: 1 });
      await writePrivateCredentialFile(path, raw);
      if (process.platform !== 'win32') {
        await chmod(path, mode);
      }
      const before = await filePrivacy(path, mutation);
      await expect(secrets.getCredential('openai')).rejects.toMatchObject({
        code: 'decrypt_failed',
        name: 'SecretReadError',
      });
      await expect(credentials.write('openai', 'owned-fixture-key')).rejects.toMatchObject({
        code: 'credential_store_unavailable',
      });
      expect(await readFile(path, 'utf8')).toBe(raw);
      expect(await filePrivacy(path)).toEqual(before);
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
      await writePrivateCredentialFile(path, raw);
      await expect(credentials.read('openai')).rejects.toMatchObject({
        code: 'credential_store_unavailable',
      });
      await expect(credentials.write('openai', 'owned-fixture-key')).rejects.toMatchObject({
        code: 'credential_store_unavailable',
      });
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  );

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'rejects a FIFO with no writer and physically joins the read before close',
    async () => {
      expect(typeof constants.O_NONBLOCK).toBe('number');
      const { credentials, path, root } = await fixture();
      await promisify(execFile)('mkfifo', ['-m', '600', path]);
      expect((await stat(path)).isFIFO()).toBe(true);
      const failures: unknown[] = [];
      try {
        await expect(credentials.read('openai', AbortSignal.timeout(1000))).rejects.toMatchObject({
          code: 'credential_store_unavailable',
        });
        expect(credentials.completion().pendingNativeOperations).toBe(0);
      } catch (cause) {
        failures.push(cause);
      }
      try {
        // Regression recovery: a nonblocking writer releases an old blocking
        // reader, without writing bytes or confusing abort with completion.
        stores.delete(credentials);
        await releaseCredentialFifoReader(path);
        await credentials.close();
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'FIFO admission or physical cleanup failed');
      }
      expect(credentials.completion()).toEqual({
        pendingNativeOperations: 0,
        queuedOperations: 0,
        state: 'closed',
      });
      expect((await stat(path)).isFIFO()).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(root)).toEqual(['explicit-credentials.json']);
    }
  );

  it('refuses a credential symlink and leaves its target untouched', async () => {
    const { credentials, path, root } = await fixture();
    const target = join(root, 'owned-target.json');
    const raw = JSON.stringify({ records: {}, secrets: {}, version: 1 });
    await writePrivateCredentialFile(target, raw);
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
    await writePrivateCredentialFile(path, marker);
    const failure: unknown = await credentials.read('openai').catch((error: unknown) => error);
    expect(failure).toMatchObject({
      cause: { code: 'credential_file_malformed', name: 'CredentialFileFormatError' },
      code: 'credential_store_unavailable',
    });
    expect(JSON.stringify(failure)).not.toContain(marker);
  });
});
