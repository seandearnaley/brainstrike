// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { createProductionHostPlatform, HostCore } from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentHostAdapterServicesFactory } from '../agent-host-platform/adapter-services';
import { mcpBearerCredentialStorageKey } from '../mcp/bearer-credential';
import { fixtureCapabilities, fixtureToolRequest } from './fixtures/agent-host-adapter-fixture';

const roots = new Set<string>();
const disposers = new Set<() => Promise<void>>();
const memoryCalculatorModule = fileURLToPath(
  new URL('./adapters/memory-storage-calculator.js', import.meta.resolve('@brainstrike/agent-host'))
);
afterEach(async () => {
  for (const dispose of [...disposers].reverse()) {
    await dispose();
  }
  disposers.clear();
  await Promise.all([...roots].map((root) => rm(root, { force: true, recursive: true })));
  roots.clear();
});
async function compositionRoot(_memory: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-authority-owned-'));
  roots.add(root);
  const store = await StateStore.open(root, { memoryCalculatorModule });
  disposers.add(() => store.close());
  return {
    root,
    startup: {
      register: async (close: () => Promise<void>) => {
        disposers.add(close);
      },
      signal: new AbortController().signal,
      store,
    },
  };
}

describe('persisted configured MCP authority', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a changed real stdio command before approval and joins both owned children',
    async () => {
      const { root, startup } = await compositionRoot(true);
      let store = startup.store;
      const script = fileURLToPath(
        import.meta.resolve('@brainstrike/agent/test-fixtures/mcp-stdio-host-lifecycle-server.mjs')
      );
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      const commands = await Promise.all(
        ['first', 'replacement'].map(async (label) => {
          const command = join(root, `${label}-mcp`);
          const pidFile = join(root, `${label}.pid`);
          const stateFile = join(root, `${label}.json`);
          await writeFile(
            command,
            `#!/bin/sh\nexport BRAINSTRIKE_STDIO_TEST_PID_FILE=${quote(pidFile)}\nexport BRAINSTRIKE_STDIO_TEST_STATE_FILE=${quote(stateFile)}\nexec ${quote(process.execPath)} ${quote(script)}\n`
          );
          await chmod(command, 0o700);
          return { command, pidFile };
        })
      );
      const [first, replacement] = commands;
      if (!(first && replacement)) {
        throw new Error('Owned stdio commands were not prepared');
      }
      const openPlatform = async (command: string) => {
        const services = await createAgentHostAdapterServicesFactory(fixtureCapabilities)({
          appUi: 'text',
          credentialStore: { kind: 'file', path: join(root, 'credentials.json') },
          mcpConfiguration: {
            servers: [
              {
                command,
                name: parseConfiguredMcpServerId('fixture.command'),
                protocol: 'legacy',
                startup: 'automatic',
                transport: 'stdio',
              },
            ],
          },
          openExternal: async () => undefined,
          openTaskDatabase: async () => {
            throw new Error('Legacy stdio fixture does not use Tasks');
          },
          root,
          startup: { ...startup, store },
        });
        disposers.add(services.close);
        const selected = await services.mcp.executableTools(fixtureToolRequest);
        const name = Object.keys(selected.bindings)[0];
        await selected.close();
        if (!name) {
          throw new Error('Real stdio fixture did not publish a tool');
        }
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
      let core = await HostCore.open(
        store,
        await openPlatform(first.command),
        () => () => undefined
      );
      try {
        const { threadId } = await core.startThread({ commandId: randomUUID() });
        const { runId } = await core.startRun({
          commandId: randomUUID(),
          modelId: 'fixture',
          prompt: 'Call the stdio probe',
          threadId,
        });
        let interactionId: string | undefined;
        await expect
          .poll(async () => {
            const pending = (await core.read(threadId, 0)).find(
              ({ event }) => event.type === 'interaction.requested'
            )?.event;
            if (pending?.type === 'interaction.requested') {
              interactionId = pending.interactionId;
            }
            return interactionId !== undefined;
          })
          .toBe(true);
        if (!interactionId) {
          throw new Error('Real stdio probe did not require approval');
        }
        const firstPid = Number(await readFile(first.pidFile, 'utf8'));
        expect(process.kill(firstPid, 0)).toBe(true);
        await core.close();
        expect(() => process.kill(firstPid, 0)).toThrow();
        await store.close();
        store = await StateStore.open(root, { memoryCalculatorModule });
        disposers.add(() => store.close());
        core = await HostCore.open(
          store,
          await openPlatform(replacement.command),
          () => () => undefined
        );
        const replacementPid = Number(await readFile(replacement.pidFile, 'utf8'));
        expect(process.kill(replacementPid, 0)).toBe(true);
        await expect(
          core.respond({
            commandId: randomUUID(),
            decision: 'approve',
            interactionId,
            runId,
            threadId,
          })
        ).rejects.toMatchObject({
          code: 'mcp-authority-reconstruction-refused',
          reason: 'configuration-changed',
        });
        expect(
          (await core.read(threadId, 0)).filter(({ event }) => event.type === 'effect.started')
        ).toHaveLength(0);
        await core.close();
        expect(() => process.kill(replacementPid, 0)).toThrow();
      } finally {
        await core.close();
        await store.close();
      }
    }
  );
  it.each(['endpoint', 'unchanged', 'credential', 'private-header', 'bearer-unchanged'] as const)(
    'preserves a persisted MCP approval only with unchanged server authority (%s)',
    async (change) => {
      const { root, startup } = await compositionRoot(true);
      const first = await startStatefulMcpHostServer();
      const replacement = await startStatefulMcpHostServer();
      disposers.add(first.close);
      disposers.add(replacement.close);
      let store = startup.store;
      let admittedServices:
        | Awaited<ReturnType<ReturnType<typeof createAgentHostAdapterServicesFactory>>>
        | undefined;
      const openPlatform = async (url: string, credentialId?: string) => {
        const services = await createAgentHostAdapterServicesFactory(fixtureCapabilities)({
          appUi: 'text',
          credentialStore: { kind: 'file', path: join(root, 'explicit-credentials.json') },
          mcpConfiguration: { servers: [] },
          openExternal: async () => undefined,
          openTaskDatabase: async () => {
            throw new Error('No Tasks database expected by this legacy fixture');
          },
          root,
          startup: { ...startup, store },
        });
        disposers.add(services.close);
        admittedServices = services;
        const credential = credentialId
          ? { id: credentialId, store: 'mcp-credentials' as const }
          : undefined;
        if (credential) {
          await services.secrets.saveKey(
            mcpBearerCredentialStorageKey(credential),
            'owned-disposable-bearer-value'
          );
        }
        await services.runtime.replaceResolvedConfig({
          servers: [
            {
              ...(credential ? { auth: { credential, type: 'bearer' as const } } : {}),
              ...(change === 'private-header'
                ? { headers: { 'X-Fixture': 'owned-private-header-value' } }
                : {}),
              name: parseConfiguredMcpServerId('fixture.restarted'),
              protocol: 'legacy',
              startup: 'automatic',
              transport: 'streamable-http',
              url,
            },
          ],
        });
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
      let core = await HostCore.open(
        store,
        await openPlatform(
          first.url,
          change === 'credential' || change === 'bearer-unchanged'
            ? '00000000-0000-4000-8000-000000000001'
            : undefined
        ),
        () => () => undefined
      );
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
        const started = (await core.read(threadId, 0)).find(
          ({ event }) => event.type === 'run.started'
        )?.event;
        if (started?.type !== 'run.started' || !started.snapshot || !admittedServices) {
          throw new Error('Real MCP admission did not commit its run capture');
        }
        expect(started.snapshot.mcpAuthorities).toBeDefined();
        expect(JSON.stringify(started.snapshot)).not.toContain('owned-disposable-bearer-value');
        expect(JSON.stringify(started.snapshot)).not.toContain('owned-private-header-value');
        const legacySnapshot = { ...started.snapshot };
        legacySnapshot.mcpAuthorities = undefined;
        await expect(
          admittedServices.mcp.executableTools({ ...fixtureToolRequest, snapshot: legacySnapshot })
        ).rejects.toMatchObject({
          code: 'mcp-authority-reconstruction-refused',
          reason: 'legacy-missing-capture',
        });
        await core.close();
        await store.close();
        if (change !== 'endpoint') {
          await first.resetSession();
        }
        store = await StateStore.open(root, { memoryCalculatorModule });
        disposers.add(() => store.close());
        const next = change === 'endpoint' ? replacement : first;
        core = await HostCore.open(
          store,
          await openPlatform(
            next.url,
            change === 'credential'
              ? '00000000-0000-4000-8000-000000000002'
              : change === 'bearer-unchanged'
                ? '00000000-0000-4000-8000-000000000001'
                : undefined
          ),
          () => () => undefined
        );
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
        const calls = next.requests.filter(
          ({ body }) => z.object({ method: z.literal('tools/call') }).safeParse(body).success
        );
        expect(calls).toHaveLength(change === 'unchanged' ? 1 : 0);
        if (change === 'unchanged') {
          expect(refusal).toBeUndefined();
        } else {
          expect(refusal).toMatchObject({
            code: 'mcp-authority-reconstruction-refused',
            reason:
              change === 'private-header' || change === 'bearer-unchanged'
                ? 'private-comparison-unavailable'
                : 'configuration-changed',
          });
        }
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
    }
  );
});
