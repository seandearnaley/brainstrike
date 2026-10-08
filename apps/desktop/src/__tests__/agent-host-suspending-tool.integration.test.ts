// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunPythonTool,
  RUN_PYTHON_TOOL_ID,
  resolveRequestPermissionPolicy,
  resolveSelfApprovalDecision,
} from '@brainstrike/agent';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * run_python is the one shipped tool besides askUser and submitPlan that can
 * suspend a legacy Mastra run (its network gate). In the agent host nothing
 * suspends: the host asks through its own approval, the client can always
 * answer that, and the network gate settles visibly instead of pausing a run
 * no client can resume or reaching the network unconfirmed.
 */
test.for(['approve', 'deny'] as const)(
  'a suspending tool pauses only as an answerable approval and never escalates (%s)',
  async (decision) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m4-suspending-tool-'));
    roots.push(root);
    let sandboxResolutions = 0;
    const binding = createAgentHostToolBindings({
      bindings: { [RUN_PYTHON_TOOL_ID]: { identity: RUN_PYTHON_TOOL_ID, risk: 'execute' } },
      resolvedToolResultBudget: resolveScaledToolResultBudget(24_000),
      tools: {
        [RUN_PYTHON_TOOL_ID]: createRunPythonTool({
          // The host-path composition: its runtime carries no legacy policy
          // request, so the tool defers its run approval to the host's gate.
          resolveApprovalDecision: () =>
            resolveSelfApprovalDecision(
              resolveRequestPermissionPolicy(undefined),
              RUN_PYTHON_TOOL_ID
            ),
          resolveHost: async () => {
            sandboxResolutions += 1;
            throw new Error('The sandbox is never resolved before both gates settle');
          },
        }),
      },
    });
    const toolId = [...binding.toolNameMap.entries()].find(
      ([, id]) => id === RUN_PYTHON_TOOL_ID
    )?.[0];
    if (!toolId) {
      throw new Error('run_python has no provider tool name');
    }
    const model = scriptedToolSequence([
      { input: { allowedDomains: ['example.com'], code: 'print(1)' }, toolId },
    ]);
    const host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        close: async () => undefined,
        maxSteps: 3,
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
        resolveModel: async () => model,
        tools: binding.tools,
      }
    );
    hosts.push(host);
    const client = await attachAgentHost(host.record);
    clients.push(client);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Fetch example.com with Python.',
      threadId,
    });
    let rows: readonly HostLogRow[] = [];
    await expect
      .poll(async () => {
        rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return rows.some(({ event }) => event.type === 'interaction.requested');
      })
      .toBe(true);
    const requested = rows.find(({ event }) => event.type === 'interaction.requested')?.event;
    if (requested?.type !== 'interaction.requested') {
      throw new Error('The host did not ask before running the suspending tool');
    }
    // An ordinary approval, which every client answers; never a typed resume.
    expect(requested).toMatchObject({ kind: 'approval', toolId });
    expect(rows.some(({ event }) => event.type === 'effect.started')).toBe(false);
    await expect(
      client.request('interaction/resume', {
        commandId: randomUUID(),
        interactionId: requested.interactionId,
        resumeData: { action: 'allow' },
        runId: requested.runId,
        threadId,
      })
    ).rejects.toThrow();

    await client.request('interaction/respond', {
      commandId: randomUUID(),
      decision,
      interactionId: requested.interactionId,
      runId: requested.runId,
      threadId,
    });
    await expect
      .poll(async () => {
        rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return rows.find(({ event }) => event.type === 'run.finished')?.event;
      })
      .toMatchObject({ outcome: 'completed' });

    expect(rows.filter(({ event }) => event.type === 'interaction.requested')).toHaveLength(1);
    expect(sandboxResolutions).toBe(0);
    const effects = rows.filter(({ event }) => event.type === 'effect.started');
    if (decision === 'deny') {
      expect(effects).toHaveLength(0);
      return;
    }
    expect(effects).toHaveLength(1);
    expect(rows.find(({ event }) => event.type === 'effect.finished')?.event).toMatchObject({
      output: { kind: 'unavailable', reason: 'network_confirmation_unavailable' },
    });
  }
);
