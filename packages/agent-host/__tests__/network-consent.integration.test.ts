import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunPythonTool } from '@brainstrike/agent';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { createAgentHostToolBindings } from '../src/adapters/canonical-tool-bindings.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;
type Posture = ReturnType<HostPlatform['readPermissionPolicy']>;

const NETWORK = { allowedDomains: ['pypi.org', 'pypi.org'], code: 'import urllib' };
const OFFLINE = { code: 'print(1)' };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

/** The shipped run_python through the canonical binding, over a fence that records its network. */
function runPythonTools() {
  const reached: (readonly string[])[] = [];
  const runPython = createRunPythonTool({
    resolveHost: async () => ({
      fence: () => ({
        capabilities: () => ({
          languages: ['python'],
          maxIsolationTier: 'os-fence',
          platform: 'darwin',
          supportsNetwork: true,
        }),
        dispose: async () => undefined,
        execute: async (input) => {
          reached.push(input.policy.allowedDomains);
          return {
            exitCode: 0,
            signal: null,
            stderr: '',
            stderrOmittedBytes: 0,
            stdout: 'ran',
            stdoutOmittedBytes: 0,
            timedOut: false,
          };
        },
      }),
    }),
  });
  const bindings = createAgentHostToolBindings({
    bindings: {
      [NATIVE_TOOL_ID.runPython]: { identity: 'run-python-generation-1', risk: 'execute' },
    },
    resolvedToolResultBudget: resolveScaledToolResultBudget(128_000),
    tools: { [NATIVE_TOOL_ID.runPython]: runPython },
  });
  const [name] = [...bindings.toolNameMap].find(([, id]) => id === NATIVE_TOOL_ID.runPython) ?? [];
  if (!name) {
    throw new Error('run_python has no host binding');
  }
  return { name, reached, tools: bindings.tools };
}

async function openHost(posture: Posture, inputs: readonly unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-network-consent-'));
  const python = runPythonTools();
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: inputs.length + 1,
    readPermissionPolicy: () => posture,
    resolveModel: async () =>
      scriptedToolSequence(inputs.map((input) => ({ input, toolId: python.name }))),
    tools: python.tools,
  };
  let store = await StateStore.open(root);
  let core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  return {
    get core(): HostCore {
      return core;
    },
    reached: python.reached,
    async reopen(): Promise<void> {
      await core.close();
      await store.close();
      store = await StateStore.open(root);
      core = await HostCore.open(store, platform, () => () => undefined);
    },
  };
}

async function events(core: HostCore, threadId: string): Promise<HostEvent[]> {
  return (await core.read(threadId, 0)).map((row: HostLogRow) => row.event);
}

async function requested(core: HostCore, threadId: string, count: number): Promise<Requested> {
  let found: Requested[] = [];
  await expect
    .poll(async () => {
      found = (await events(core, threadId)).filter(
        (event): event is Requested => event.type === 'interaction.requested'
      );
      return found.length;
    })
    .toBe(count);
  const last = found.at(-1);
  if (!last) {
    throw new Error('Expected an interaction request');
  }
  return last;
}

async function finished(core: HostCore, threadId: string) {
  await expect
    .poll(async () => (await events(core, threadId)).find((event) => event.type === 'run.finished'))
    .toMatchObject({ outcome: 'completed' });
  return (await events(core, threadId)).flatMap((event) =>
    event.type === 'effect.finished' ? [event.output] : []
  );
}

async function start(core: HostCore) {
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Fetch it with Python.',
    threadId,
  });
  return { runId, threadId };
}

test.each([
  ['an allowing policy', { policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'allow' } }],
  ['yolo', { policies: DEFAULT_PERMISSION_POLICIES, yolo: true }],
] as const)(
  'under %s each networked call asks a person first, per call',
  async (_label, posture) => {
    const host = await openHost({ yolo: false, ...posture }, [NETWORK, NETWORK]);
    const { runId, threadId } = await start(host.core);

    const first = await requested(host.core, threadId, 1);
    expect(first).toMatchObject({ kind: 'network', toolCatalogId: NATIVE_TOOL_ID.runPython });
    expect(first).not.toHaveProperty('risk');
    expect(first.executionContext).toMatchObject({ allowedDomains: NETWORK.allowedDomains });
    await expect(
      host.core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: first.interactionId,
        runId,
        threadId,
      })
    ).rejects.toThrow('Approval decision is stale or belongs to another run');
    await expect(
      host.core.resume({
        commandId: randomUUID(),
        grant: { category: 'execute', scope: 'session' },
        interactionId: first.interactionId,
        resumeData: { action: 'allow' },
        runId,
        threadId,
      })
    ).rejects.toThrow('Only a network consent that stood in for an approval carries a grant');
    await host.core.resume({
      commandId: randomUUID(),
      interactionId: first.interactionId,
      resumeData: { action: 'allow' },
      runId,
      threadId,
    });

    const second = await requested(host.core, threadId, 2);
    expect(second).toMatchObject({ kind: 'network' });
    await host.core.resume({
      commandId: randomUUID(),
      interactionId: second.interactionId,
      resumeData: { action: 'deny' },
      runId,
      threadId,
    });

    const outputs = await finished(host.core, threadId);
    expect(host.reached).toEqual([['pypi.org']]);
    expect(outputs).toEqual([
      expect.objectContaining({ kind: 'completed', stdout: 'ran' }),
      { deniedDomains: ['pypi.org'], kind: 'network_denied' },
    ]);
  }
);

test('under ask one card also approves the run; its grant covers the approval, never the network', async () => {
  const host = await openHost(
    { policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'ask' }, yolo: false },
    [NETWORK, NETWORK, OFFLINE]
  );
  const { runId, threadId } = await start(host.core);

  const first = await requested(host.core, threadId, 1);
  expect(first).toMatchObject({ kind: 'network', risk: 'execute' });
  await host.core.resume({
    commandId: randomUUID(),
    grant: { category: 'execute', scope: 'session' },
    interactionId: first.interactionId,
    resumeData: { action: 'allow' },
    runId,
    threadId,
  });

  const second = await requested(host.core, threadId, 2);
  expect(second).toMatchObject({ kind: 'network' });
  expect(second).not.toHaveProperty('risk');
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: second.interactionId,
    resumeData: { action: 'allow' },
    runId,
    threadId,
  });

  await finished(host.core, threadId);
  const log = await events(host.core, threadId);
  expect(log.filter((event) => event.type === 'interaction.requested')).toHaveLength(2);
  expect(log.filter((event) => event.type === 'permission.granted')).toEqual([
    { grant: { category: 'execute', scope: 'session' }, runId, type: 'permission.granted' },
  ]);
  expect(host.reached).toEqual([['pypi.org'], ['pypi.org'], []]);
  // The committed log the desktop's network card replays
  // (apps/desktop/src/__tests__/fixtures/committed-host-network.json).
  const recordTo = process.env['BRAINSTRIKE_RECORD_NETWORK_CONSENT'];
  if (recordTo) {
    await writeFile(
      join(recordTo, 'committed-host-network.json'),
      JSON.stringify(await host.core.read(threadId, 0), null, 2)
    );
  }
});

test('a network card survives a host restart and is answered there', async () => {
  const host = await openHost(
    { policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'ask' }, yolo: false },
    [NETWORK]
  );
  const { runId, threadId } = await start(host.core);
  const card = await requested(host.core, threadId, 1);

  await host.reopen();
  const reopened = await events(host.core, threadId);
  expect(reopened.filter((event) => event.type === 'interaction.requested')).toEqual([card]);
  expect(
    reopened.some(
      (event) => event.type === 'interaction.responded' || event.type === 'run.finished'
    )
  ).toBe(false);
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: card.interactionId,
    resumeData: { action: 'allow' },
    runId,
    threadId,
  });

  expect(await finished(host.core, threadId)).toEqual([
    expect.objectContaining({ kind: 'completed', stdout: 'ran' }),
  ]);
  expect(host.reached).toEqual([['pypi.org']]);
});
