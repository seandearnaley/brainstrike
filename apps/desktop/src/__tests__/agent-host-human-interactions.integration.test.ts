// @vitest-environment node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAskUserTool, createSubmitPlanTool } from '@brainstrike/agent';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import {
  observeFixtureChild,
  recordFixtureEvent,
} from '@brainstrike/agent-host/test-fixtures/owned-process';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { processStartTime } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test.for(
  [
    {
      id: NATIVE_TOOL_ID.askUser,
      input: {
        options: [{ label: 'Local' }, { label: 'Preview' }],
        question: 'Which environment?',
        selectionMode: 'multi_select',
      },
      kind: 'question',
      output: { answer: 'Local, Preview' },
      resumeData: { answer: ['Local', 'Preview'] },
      tool: createAskUserTool(),
    },
    {
      id: NATIVE_TOOL_ID.submitPlan,
      input: {
        overview: 'Apply the selected change.',
        steps: [{ title: 'Inspect' }],
        title: 'Plan',
      },
      kind: 'plan',
      output: { feedback: 'Inspect the current change first.', status: 'rejected' },
      resumeData: { action: 'rejected', feedback: 'Inspect the current change first.' },
      tool: createSubmitPlanTool(),
    },
  ].flatMap((fixture) => [
    ...[false, true].flatMap((restart) =>
      [1, 3].map((maxSteps) => ({ ...fixture, clientType: 'protocol', maxSteps, restart }))
    ),
    { ...fixture, clientType: 'cli', maxSteps: 3, restart: true },
  ])
)(
  'canonical $kind answers once (restart=$restart, steps=$maxSteps, client=$clientType)',
  async (fixture, { signal }) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-human-interaction-'));
    roots.push(root);
    const binding = createAgentHostToolBindings({
      bindings: { [fixture.id]: { identity: fixture.id, risk: 'read' } },
      resolvedToolResultBudget: resolveScaledToolResultBudget(24_000),
      tools: { [fixture.id]: fixture.tool },
    });
    const toolId = [...binding.toolNameMap.entries()].find(([, id]) => id === fixture.id)?.[0];
    if (!toolId) {
      throw new Error('Canonical human interaction has no provider tool name');
    }
    const model = scriptedToolSequence([{ input: fixture.input, toolId }]);
    const platform = {
      close: async () => undefined,
      maxSteps: fixture.maxSteps,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: binding.tools,
    };
    let host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    hosts.push(host);
    let client = await attachAgentHost(host.record);
    clients.push(client);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Use the selected canonical human interaction.',
      threadId,
    });
    let rows: readonly HostLogRow[] = [];
    await expect
      .poll(async () => {
        rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return rows.some(({ event }) =>
          ['interaction.requested', 'run.finished'].includes(event.type)
        );
      })
      .toBe(true);
    expect(rows.find(({ event }) => event.type === 'interaction.requested')?.event).toMatchObject({
      input: fixture.input,
      kind: fixture.kind,
      toolId,
    });
    expect(rows.some(({ event }) => event.type === 'run.finished')).toBe(false);
    expect(rows.some(({ event }) => event.type === 'effect.started')).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
    const requested = rows.find(({ event }) => event.type === 'interaction.requested')?.event;
    if (requested?.type !== 'interaction.requested') {
      throw new Error('Canonical human interaction was not committed');
    }
    if (fixture.restart) {
      await expect
        .poll(async () => {
          rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
          return rows.some(
            ({ event }) =>
              event.type === 'stream.chunk' &&
              event.chunk !== null &&
              typeof event.chunk === 'object' &&
              !Array.isArray(event.chunk) &&
              event.chunk['type'] === 'finish'
          );
        })
        .toBe(true);
      await client.close();
      await host.close();
      host = await startAgentHost({ lifetime: 'persistent', root }, platform);
      hosts.push(host);
      client = await attachAgentHost(host.record);
      clients.push(client);
      expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(rows);
    }
    await expect(
      client.request('interaction/respond', {
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: requested.interactionId,
        runId: requested.runId,
        threadId,
      })
    ).rejects.toThrow(/stale/);
    await expect(
      client.request('interaction/resume', {
        commandId: randomUUID(),
        interactionId: requested.interactionId,
        resumeData: { unexpected: true },
        runId: requested.runId,
        threadId,
      })
    ).rejects.toThrow();
    const response = {
      commandId: randomUUID(),
      interactionId: requested.interactionId,
      resumeData: z.json().parse(fixture.resumeData),
      runId: requested.runId,
      threadId,
    };
    if (fixture.clientType === 'cli') {
      const started = performance.now();
      const child = spawn(
        process.execPath,
        [
          resolve(import.meta.dirname, '../../../../packages/agent-host/dist/cli.js'),
          '--data-root',
          root,
          'attach',
          '--thread',
          threadId,
          '--run',
          requested.runId,
          '--interactive',
          '--json',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const observed = observeFixtureChild(child, (pid) => {
        const start = processStartTime(pid);
        if (!start) {
          throw new Error('Cannot identify the owned canonical interaction CLI');
        }
        return { executable: process.execPath, pid, start };
      });
      try {
        // BST-1977: Windows emitted the actual prompt after 1.715s; the
        // library's 1s poll default is not an accepted product latency gate.
        // Observe the real output/exit within the unchanged test cancellation.
        await observed.output.waitFor('stderr', 'with JSON', signal);
        recordFixtureEvent('canonical-interaction-cli-prompt-readiness', {
          elapsedMs: performance.now() - started,
          kind: fixture.kind,
          root,
        });
        expect(observed.output.stderr()).toContain('with JSON');
        child.stdin.write('{"unexpected":true}\n');
        await observed.output.waitFor('stderr', 'Interaction rejected:', signal);
        expect(observed.output.stderr()).toContain('Interaction rejected:');
        child.stdin.write(`${JSON.stringify(fixture.resumeData)}\n`);
        expect((await observed.done).code).toBe(0);
        const liveRows = observed.output
          .stdout()
          .trim()
          .split('\n')
          .map((line) => HostLogRowSchema.parse(JSON.parse(line)));
        expect(liveRows.at(-1)?.event).toMatchObject({
          outcome: 'completed',
          type: 'run.finished',
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
        }
        await observed.done;
      }
    } else {
      await client.request('interaction/resume', response);
      await client.request('interaction/resume', response);
    }
    await expect
      .poll(async () => {
        rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return rows.find(({ event }) => event.type === 'run.finished')?.event;
      })
      .toMatchObject({ outcome: 'completed' });
    expect(rows.filter(({ event }) => event.type === 'effect.started')).toHaveLength(1);
    expect(rows.filter(({ event }) => event.type === 'interaction.responded')).toHaveLength(1);
    expect(rows.find(({ event }) => event.type === 'effect.finished')?.event).toMatchObject({
      output: fixture.output,
    });
    expect(model.doStreamCalls).toHaveLength(fixture.maxSteps === 1 ? 1 : 2);
    const modelOutput = model.doStreamCalls[1]?.prompt
      .flatMap((message) => (message.role === 'tool' ? message.content : []))
      .find((part) => part.type === 'tool-result');
    if (
      fixture.maxSteps > 1 &&
      (modelOutput?.type !== 'tool-result' || modelOutput.output.type !== 'text')
    ) {
      throw new Error('Canonical projection did not supply the recorded SDK text result');
    }
    if (modelOutput?.type === 'tool-result' && modelOutput.output.type === 'text') {
      expect(JSON.parse(modelOutput.output.value)).toEqual(fixture.output);
    }
    if (
      process.env['BRAINSTRIKE_RECORD_HUMAN_INTERACTIONS'] &&
      !fixture.restart &&
      fixture.maxSteps === 3
    ) {
      await writeFile(
        join(process.env['BRAINSTRIKE_RECORD_HUMAN_INTERACTIONS'], `${fixture.kind}.json`),
        JSON.stringify(rows, null, 2)
      );
    }
  }
);
