/**
 * BST-2527: after a compaction the model still knows which files the thread
 * edited, which tools it loaded and what the person asked in their own words:
 * the host writes them into the compaction note from the committed log.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  committedRunMessages,
  createHostToolDiscovery,
} from '../src/adapters/host-tool-discovery.ts';
import type { HostRunAdmission, HostTool } from '../src/ports.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { type ScriptedTurn, scriptedTurns } from '../src/test-fixtures/scripted-model.ts';
import {
  type CallOptions,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const SUMMARY = [
  'Goal: Move the service to port 8443.',
  'Constraints: Keep the old default in a comment.',
  'Decisions: Port 8443.',
  'Errors and fixes: None.',
  'State: The port is moved.',
  'Next: Write the notes.',
].join('\n');

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
type Call = ScriptedTurn['steps'][number][number];

function compactions(rows: readonly HostLogRow[]): Compacted[] {
  return rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []));
}

/** The system text a request carried: the run's instructions and its compaction note. */
function systemText(call: CallOptions | undefined): string {
  return (call?.prompt ?? [])
    .flatMap((message) => (message.role === 'system' ? [message.content] : []))
    .join('\n');
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** A file tool that writes through Core's edit tracker, as the native file tools do. */
function editTool(root: string): HostTool {
  return {
    description: 'Write a workspace file',
    execute: async (input, context) => {
      const { content, path } = input as { content: string; path: string };
      const absolutePath = join(root, path);
      if (!context.edits) {
        throw new Error('A file tool needs Core’s edit tracker');
      }
      return await context.edits.track(
        { absolutePath, op: 'write', rootId: 'root-1', rootPath: root },
        async () => {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, content);
          return { written: true };
        }
      );
    },
    identity: 'native-edit-generation-1',
    inputSchema: z.object({ content: z.string(), path: z.string() }),
    risk: 'edit',
  };
}

const lspInspect: HostTool = {
  description: 'Inspect a symbol with the language server',
  execute: async () => ({ hover: 'const answer: 42' }),
  identity: 'native-lsp-generation-1',
  inputSchema: z.object({ path: z.string() }),
  permissionToolId: 'brainstrike.lspInspect',
  risk: 'read',
};

/** A skill load: a step that calls it is kept word for word when the steps around it compact. */
const skill: HostTool = {
  description: 'Load a skill',
  execute: async () => ({ instructions: 'Review every chapter twice.' }),
  identity: 'native-skill-generation-1',
  inputSchema: z.object({ name: z.string() }),
  risk: 'read',
};

const edit = (path: string, content: string): Call => ({
  input: { content, path },
  toolId: 'edit_file',
});

/** A host of `turns` under `inputTokenLimit`, with hosted discovery over its committed log. */
async function ledgerHost(turns: readonly ScriptedTurn[], inputTokenLimit: number) {
  const root = await mkdtemp(join(tmpdir(), 'bs-compaction-ledger-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const model = scriptedTurns(turns, SUMMARY);
  let store: StateStore | undefined;
  const harness = await setupChildRunHost(
    model,
    cleanup,
    {
      readFile: async () => ({ content: 'n'.repeat(16_000) }),
      tools: { brainstrike_lspInspect: lspInspect, edit_file: editTool(root), skill },
    },
    (platform) => async (request) => {
      const admitted = await recordingAdmission([])(platform)?.(request);
      if (!(admitted && store)) {
        throw new Error('The fixture admission admitted nothing');
      }
      const opened = store;
      // Hosted discovery, as the production platform composes it over the committed log.
      const created = await createHostToolDiscovery({
        modelId: 'gpt-6-sol',
        provider: 'openai',
        readRunMessages: (key) => committedRunMessages(opened, key),
        tools: admitted.tools,
      });
      if (!created) {
        throw new Error('Nothing deferred behind discovery');
      }
      const tools = { ...admitted.tools, ...created.tools };
      return {
        ...admitted,
        discovery: created.discovery,
        inputTokenLimit,
        snapshot: {
          ...admitted.snapshot,
          maxSteps: 40,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      } satisfies HostRunAdmission;
    }
  );
  store = harness.store;
  return { harness, model };
}

test('the note lists the files a compacted run edited and the tools it loaded, from the log', async () => {
  const question = 'Move the port, then read the notes twenty times.';
  const { harness, model } = await ledgerHost(
    [
      {
        answer: 'Done.',
        prompt: question,
        steps: [
          [{ input: { toolName: 'brainstrike_lspInspect' }, toolId: 'load_tool' }],
          [edit('src/server.ts', 'export const PORT = 8080;\n')],
          [edit('src/server.ts', 'export const PORT = 8443;\n')],
          [edit('docs/port.md', 'Port 8443.\n')],
          ...Array.from({ length: 20 }, () => [
            { input: { path: 'notes.md' }, toolId: 'read_file' },
          ]),
        ],
      },
    ],
    40_000
  );
  const runId = await harness.start(question);
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 30_000);
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });

  // Every compaction of the run lists the edits and the load its steps made,
  // and no earlier request: the run's own question is still in its request.
  const committed = compactions(rows);
  expect(committed.length).toBeGreaterThan(1);
  for (const event of committed) {
    expect(event).toMatchObject({
      earlierRequests: [],
      filesEdited: [
        { edits: 2, path: 'src/server.ts' },
        { edits: 1, path: 'docs/port.md' },
      ],
      toolsLoaded: ['brainstrike_lspInspect'],
    });
  }
  // After several compactions the last request carries one note with one summary, and the lists.
  const system = systemText(model.doStreamCalls.at(-1));
  expect(occurrences(system, '[Earlier conversation compacted]')).toBe(1);
  expect(occurrences(system, 'Goal: Move the service to port 8443.')).toBe(1);
  expect(system).toContain('Files edited:\n- src/server.ts (2 edits)\n- docs/port.md (1 edit)');
  expect(system).toContain('Tools loaded:\n- brainstrike_lspInspect');
  expect(system).not.toContain('Earlier requests:');
});

test('a step the compaction kept word for word is not listed: its edit and its load are still in the request', async () => {
  const question = 'Load the review skill, move the port, then read the notes twenty times.';
  const { harness, model } = await ledgerHost(
    [
      {
        answer: 'Done.',
        prompt: question,
        steps: [
          // One step: the skill load keeps it, with the load and the edit beside it.
          [
            { input: { name: 'review' }, toolId: 'skill' },
            { input: { toolName: 'brainstrike_lspInspect' }, toolId: 'load_tool' },
            edit('docs/review.md', 'Reviewed.\n'),
          ],
          [edit('src/server.ts', 'export const PORT = 8080;\n')],
          [edit('src/server.ts', 'export const PORT = 8443;\n')],
          ...Array.from({ length: 20 }, () => [
            { input: { path: 'notes.md' }, toolId: 'read_file' },
          ]),
        ],
      },
    ],
    40_000
  );
  const runId = await harness.start(question);
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 30_000);
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });

  const committed = compactions(rows);
  expect(committed.length).toBeGreaterThan(1);
  for (const event of committed) {
    expect(event).toMatchObject({
      filesEdited: [{ edits: 2, path: 'src/server.ts' }],
      through: { kept: [0], runId },
      toolsLoaded: [],
    });
  }
  const last = model.doStreamCalls.at(-1);
  const system = systemText(last);
  expect(system).toContain('Files edited:\n- src/server.ts (2 edits)');
  expect(system).not.toContain('docs/review.md');
  expect(system).not.toContain('Tools loaded:');
  // The kept step itself is still sent, so the model reads its edit and load there.
  expect(JSON.stringify(last?.prompt)).toContain('docs/review.md');
  expect((last?.tools ?? []).map((tool) => tool.name)).toContain('brainstrike_lspInspect');
});

test('a wholly compacted turn’s request is in the note word for word, cut at its limit', async () => {
  const first = `Move the service to port 8443.\nKeep the old default in a comment.\n${'z'.repeat(2000)}`;
  const second = `Second ${'b'.repeat(40_000)}`;
  const third = `Third ${'c'.repeat(40_000)}`;
  const { harness, model } = await ledgerHost(
    [
      // About 20,000 estimated tokens of writing: the turn the third one compacts.
      {
        answer: 'Moved.',
        prompt: first.slice(0, 60),
        steps: [[edit('src/server.ts', 'x'.repeat(80_000))]],
      },
      { answer: 'Second answered.', prompt: 'Second', steps: [] },
      { answer: 'Third answered.', prompt: 'Third', steps: [] },
    ],
    40_000
  );
  const ask = async (prompt: string) => {
    const runId = await harness.start(prompt);
    await rowsUntil(harness, harness.threadId, finished(runId), 15_000);
    return runId;
  };
  const firstRun = await ask(first);
  await ask(second);
  const thirdRun = await ask(third);
  const rows = await harness.core().read(harness.threadId, 0);

  expect(compactions(rows)).toMatchObject([
    {
      compactedRunIds: [firstRun],
      earlierRequests: [`${first.slice(0, 1000)} [truncated]`],
      filesEdited: [{ edits: 1, path: 'src/server.ts' }],
      kind: 'agentic',
      runId: thirdRun,
      toolsLoaded: [],
    },
  ]);
  // Its lines as the person wrote them, up to the limit and its marker.
  const kept = 1000 - first.indexOf('z');
  const system = systemText(model.doStreamCalls.at(-1));
  expect(system).toContain(
    `Earlier requests:\n- Move the service to port 8443.\n  Keep the old default in a comment.\n  ${'z'.repeat(kept)} [truncated]`
  );
  expect(system).not.toContain('z'.repeat(kept + 1));
});
