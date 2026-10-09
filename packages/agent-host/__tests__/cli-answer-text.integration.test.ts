/**
 * The terminal prints a run's answer once: live from `run/telemetry` while it
 * watches, and from the committed `model.step` text when it replays or
 * attaches to a run it did not watch (ADR-0011 amendment).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { runHostCliSession } from '../src/cli-session.js';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('the terminal prints the answer live, and from the committed step on replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-cli-answer-text-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedModel(),
      tools: {},
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

  let watched = '';
  let runId = '';
  await runHostCliSession({
    client,
    interactive: false,
    json: false,
    output: { write: (value) => (watched += value) },
    startRun: async () => {
      ({ runId } = await client.request('run/start', {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Answer',
        threadId,
      }));
      return { runId };
    },
    threadId,
  });
  expect(watched.split('Host run completed.')).toHaveLength(2);

  let replayed = '';
  await runHostCliSession({
    client,
    interactive: false,
    json: false,
    output: { write: (value) => (replayed += value) },
    runId,
    threadId,
  });
  expect(replayed.split('Host run completed.')).toHaveLength(2);
});
