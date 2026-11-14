/**
 * BST-2536: a person compacts a thread between runs, optionally saying what to
 * keep. The host commits one `context.compacted` under the run the branch ends
 * with; its summary is asked on the request the thread's next run would send,
 * and that run starts from it. A refusal commits nothing.
 */
import { randomUUID } from 'node:crypto';
import { createMastraAgentError } from '@brainstrike/agent';
import { COMPACTION_SUMMARIZER_INSTRUCTIONS } from '@brainstrike/agent/provider-runtime';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, test } from 'vitest';
import type { HostRunAdmissionRequest } from '../src/ports.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { type ScriptedTurn, scriptedTurns } from '../src/test-fixtures/scripted-model.ts';
import {
  blocked,
  type CallOptions,
  childThreads,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
type Prompt = CallOptions['prompt'];

const MODEL = 'openai::gpt-6-luna';
const SUMMARY = [
  'Goal: Read the notes.',
  'Constraints: None.',
  'Decisions: Keep the parser.',
  'Errors and fixes: None.',
  'State: Three questions answered.',
  'Next: Answer the next question.',
].join('\n');
const FOCUS = 'Keep the parser decision.';
const HOLD = 'Hold this question.';

/** Six reads of about 4,000 estimated tokens each: one turn fills the protect window. */
function turn(prompt: string): ScriptedTurn {
  return {
    answer: `Answered: ${prompt}`,
    prompt,
    steps: Array.from({ length: 6 }, () => [{ input: { path: 'notes.md' }, toolId: 'read_file' }]),
  };
}
const QUESTIONS = [
  'First question.',
  'Second question.',
  'Third question.',
  'Fourth question.',
  'Sibling question.',
  'Sibling follow-up.',
] as const;
/** A turn with no tool call: nothing in it is droppable. */
const SHORT: ScriptedTurn = { answer: 'Short answer.', prompt: 'Short question.', steps: [] };

/** The text of a provider prompt message's text parts. */
function texts(message: Prompt[number] | undefined): string[] {
  const content = message?.content ?? [];
  if (typeof content === 'string') {
    return [content];
  }
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
}

/** Whether a user message is the host's notice rather than the person's words. */
function isNotice(message: Prompt[number]): boolean {
  return texts(message).some((text) => text.startsWith('<brainstrike_notice>'));
}

/** The person's own user messages of a request. */
function personWords(prompt: Prompt): string {
  return prompt
    .filter((message) => message.role === 'user' && !isNotice(message))
    .flatMap(texts)
    .join('\n');
}

/** The compaction note leading the request's history, or '' when it has none. */
function note(prompt: Prompt): string {
  const first = prompt.find((message) => message.role !== 'system');
  return first && isNotice(first) ? texts(first).join('') : '';
}

interface Gate {
  readonly entered: Promise<void>;
  open: () => void;
}

/**
 * A thread host whose summary call answers `summary`, or waits at `gate` until
 * it opens or its call is aborted. Each run's first request is kept by prompt.
 */
async function compactingHost() {
  const scripted = scriptedTurns([...QUESTIONS.map(turn), SHORT], SUMMARY);
  const summaries: CallOptions[] = [];
  const firstRequests = new Map<string, CallOptions>();
  const control: { answer: string | undefined; credential: boolean; gate?: Gate } = {
    answer: undefined,
    credential: true,
  };
  const compactionAdmissions = { closed: 0, opened: 0 };
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      summaries.push(options);
      const gate = control.gate;
      if (gate) {
        await new Promise<void>((resolve, reject) => {
          const signal = options.abortSignal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          gate.open = resolve;
          (gate as { resolveEntered?: () => void }).resolveEntered?.();
        });
      }
      const answered = await scripted.doGenerate(options);
      return control.answer === undefined
        ? answered
        : { ...answered, content: [{ text: control.answer, type: 'text' }] };
    },
    doStream: async (options) => {
      const latest = options.prompt.findLast((message) => message.role === 'user');
      const asked = latest ? texts(latest).join('') : '';
      if (asked.includes(HOLD)) {
        return blocked(options);
      }
      if (!firstRequests.has(asked)) {
        firstRequests.set(asked, options);
      }
      return await scripted.doStream(options);
    },
  });
  const harness = await setupChildRunHost(
    model,
    cleanup,
    { readFile: async () => ({ content: 'n'.repeat(16_000) }) },
    (platform) => async (request: HostRunAdmissionRequest) => {
      // A compaction's admission has no prompt: it answers no message.
      const compaction = request.prompt === undefined;
      if (compaction && !control.credential) {
        throw createMastraAgentError('mastra_agent_missing_api_key', {
          context: { provider: 'openai' },
        });
      }
      const admitted = await recordingAdmission([])(platform)?.(request);
      if (!admitted) {
        throw new Error('The fixture admission admitted nothing');
      }
      if (compaction) {
        compactionAdmissions.opened += 1;
      }
      return {
        ...admitted,
        ...(compaction
          ? {
              close: async () => {
                compactionAdmissions.closed += 1;
              },
            }
          : {}),
        snapshot: { ...admitted.snapshot, maxSteps: 40 },
      };
    }
  );
  const { threadId } = harness;
  const commands = new Map<string, string>();
  /** A finished run of `prompt`, after `parentMessageId` when given. */
  const ask = async (prompt: string, parentMessageId?: string): Promise<string> => {
    const commandId = randomUUID();
    commands.set(prompt, commandId);
    const { runId } = await harness.core().startRun({
      commandId,
      modelId: MODEL,
      prompt,
      threadId,
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
    });
    await rowsUntil(harness, threadId, finished(runId), 30_000);
    return runId;
  };
  const compact = (params: { focus?: string; parentMessageId?: string | null } = {}) =>
    harness.core().compactNow.compact({ commandId: randomUUID(), threadId, ...params });
  /** The thread's committed compactions, read from the store: a closed Core serves no reads. */
  const compactions = async (): Promise<Compacted[]> =>
    (await harness.store.read(threadId, 0)).flatMap(({ event }) => {
      // The stored body carries its row's sequence first.
      const { seq: _seq, ...stored } = event as unknown as Compacted & { readonly seq: number };
      return stored.type === 'context.compacted' ? [stored] : [];
    });
  /** The summary call waits until `open` (or its abort); `entered` settles once it started. */
  const hold = (): Gate => {
    const entered = Promise.withResolvers<void>();
    const gate: Gate & { resolveEntered: () => void } = {
      entered: entered.promise,
      open: () => undefined,
      resolveEntered: entered.resolve,
    };
    control.gate = gate;
    return gate;
  };
  /** The prompt of the first request the run asking `question` sent. */
  const firstPrompt = (question: string): Prompt => firstRequests.get(question)?.prompt ?? [];
  return {
    ask,
    commands,
    compact,
    compactionAdmissions,
    compactions,
    control,
    firstPrompt,
    firstRequests,
    harness,
    hold,
    summaries,
    threadId,
  };
}

/** A thread of three answered questions: the first is droppable. */
async function threeTurns() {
  const host = await compactingHost();
  const runs = [
    await host.ask('First question.'),
    await host.ask('Second question.'),
    await host.ask('Third question.'),
  ];
  return { ...host, runs };
}

function rowsOf(rows: readonly HostLogRow[], type: HostEvent['type']): number {
  return rows.filter((row) => row.event.type === type).length;
}

describe('Compact now', () => {
  test('commits one requested compaction under the branch’s run, priced, and the focus reaches the summary request as the person’s words', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const before = await host.harness.core().read(host.threadId, 0);

    const event = await host.compact({ focus: FOCUS });

    expect(event).toMatchObject({
      compactedRunIds: [host.runs[0]],
      earlierRequests: ['First question.'],
      focus: FOCUS,
      kind: 'agentic',
      modelId: MODEL,
      reason: 'requested',
      runId: host.runs[2],
      summary: SUMMARY,
      type: 'context.compacted',
    });
    expect(await host.compactions()).toEqual([event]);
    // No run started for it.
    const after = await host.harness.core().read(host.threadId, 0);
    expect(rowsOf(after, 'run.started')).toBe(rowsOf(before, 'run.started'));

    // One summary call: the thread's next request, then the host's request and the person's words.
    expect(host.summaries).toHaveLength(1);
    const prompt = host.summaries[0]?.prompt ?? [];
    expect(personWords(prompt)).toContain('First question.');
    const request = prompt.at(-1);
    expect(request?.role).toBe('user');
    const [notice, words, ...rest] = texts(request);
    expect(notice).toContain(COMPACTION_SUMMARIZER_INSTRUCTIONS);
    expect(notice).not.toContain(FOCUS);
    expect(words).toBe(FOCUS);
    expect(rest).toEqual([]);
    // The tools the thread's runs offer, unchanged.
    expect(host.summaries[0]?.tools).toEqual(host.firstRequests.get('Third question.')?.tools);

    // The summary's usage is priced in the thread's ledger.
    const ledger = host.harness
      .core()
      .readLedger()
      .threads.find((thread) => thread.threadId === host.threadId);
    expect(ledger?.perModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputTokens: expect.any(Number),
          runKind: 'compaction-summary',
        }),
      ])
    );
    expect(host.compactionAdmissions).toEqual({ closed: 1, opened: 1 });
  });

  test('the thread’s next run starts from the summary', { timeout: 60_000 }, async () => {
    const host = await threeTurns();
    await host.compact();
    await host.ask('Fourth question.');

    const next = host.firstPrompt('Fourth question.');
    expect(note(next)).toContain(`[Earlier conversation compacted]\n${SUMMARY}`);
    expect(personWords(next)).not.toContain('First question.');
    expect(personWords(next)).toContain('Second question.');
  });

  test('a named branch compacts, and its sibling branch reads nothing', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    // A sibling of the third question: the newest run is on the other branch.
    const sibling = await host.ask('Sibling question.', host.runs[1]);

    const event = await host.compact({ parentMessageId: host.runs[2] ?? '' });
    expect(event.runId).toBe(host.runs[2]);

    await host.ask('Sibling follow-up.', sibling);
    const other = host.firstPrompt('Sibling follow-up.');
    expect(note(other)).toBe('');
    expect(personWords(other)).toContain('First question.');

    await host.ask('Fourth question.', host.runs[2]);
    expect(note(host.firstPrompt('Fourth question.'))).toContain(SUMMARY);
  });

  test('a rewind to before the compaction’s turn brings the turns back, and a rewound thread is refused', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    await host.compact();
    await host.harness.core().rewinds.rewind({
      commandId: randomUUID(),
      messageId: host.commands.get('Third question.') ?? '',
      mode: 'conversation-only',
      threadId: host.threadId,
    });

    await expect(host.compact()).rejects.toMatchObject({ code: 'compaction.rewound' });

    await host.ask('Fourth question.');
    const next = host.firstPrompt('Fourth question.');
    expect(note(next)).toBe('');
    expect(personWords(next)).toContain('First question.');
    expect(personWords(next)).not.toContain('Third question.');
    expect(await host.compactions()).toHaveLength(1);
  });

  test('a failed summary commits nothing, and the next run sends the full history', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    host.control.answer = 'Not the six sections.';

    await expect(host.compact({ focus: FOCUS })).rejects.toMatchObject({
      code: 'compaction.summary-invalid',
    });
    expect(await host.compactions()).toEqual([]);
    expect(host.compactionAdmissions).toEqual({ closed: 1, opened: 1 });

    host.control.answer = undefined;
    await host.ask('Fourth question.');
    const next = host.firstPrompt('Fourth question.');
    expect(note(next)).toBe('');
    expect(personWords(next)).toContain('First question.');
  });

  test('a refused summary the provider billed is priced in the ledger, and commits no compaction', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const summaryCosts = () =>
      (
        host.harness
          .core()
          .readLedger()
          .threads.find((thread) => thread.threadId === host.threadId)?.perModel ?? []
      ).filter((entry) => entry.runKind === 'compaction-summary');
    expect(summaryCosts()).toEqual([]);
    host.control.answer = 'Not the six sections.';

    await expect(host.compact()).rejects.toMatchObject({ code: 'compaction.summary-invalid' });

    expect(await host.compactions()).toEqual([]);
    // Its receipt is the tip run's side call, as a thread title's is.
    expect(summaryCosts()).toEqual([
      expect.objectContaining({ inputTokens: expect.any(Number), outputTokens: 1 }),
    ]);
    const rows = await host.harness.core().read(host.threadId, 0);
    expect(rows.at(-1)?.event).toMatchObject({
      kind: 'compaction-summary',
      modelId: MODEL,
      runId: host.runs[2],
      type: 'model.usage',
    });
  });

  test('is refused while a run is active, when nothing is droppable and without a credential; each commits nothing', {
    timeout: 60_000,
  }, async () => {
    const empty = await compactingHost();
    await expect(empty.compact()).rejects.toMatchObject({
      code: 'compaction.nothing-to-compact',
    });
    await empty.ask('Short question.');
    await expect(empty.compact()).rejects.toMatchObject({
      code: 'compaction.nothing-to-compact',
    });
    expect(await empty.compactions()).toEqual([]);

    const host = await threeTurns();
    const { runId } = await host.harness.core().startRun({
      commandId: randomUUID(),
      modelId: MODEL,
      prompt: HOLD,
      threadId: host.threadId,
    });
    await expect(host.compact()).rejects.toMatchObject({ code: 'compaction.run-active' });
    await host.harness.core().stop({ commandId: randomUUID(), runId, threadId: host.threadId });
    await rowsUntil(host.harness, host.threadId, finished(runId), 30_000);

    host.control.credential = false;
    await expect(host.compact()).rejects.toMatchObject({ code: 'mastra_agent_missing_api_key' });
    expect(await host.compactions()).toEqual([]);
    expect(host.summaries).toEqual([]);
  });
});

test('a delegated child thread is refused before any admission, and commits nothing', {
  timeout: 60_000,
}, async () => {
  const TASK = 'CHILD_TASK: read the notes.';
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call)[0]?.includes(TASK)) {
        return stream(text('Child done.'));
      }
      const answered = call.prompt.some((message) => message.role === 'tool');
      return !toolNames(call).includes('agent-worker') || answered
        ? stream(text('Parent continues.'))
        : stream(toolCall('agent-worker', { prompt: TASK }, 'delegate-1'));
    },
  });
  const admissions: HostRunAdmissionRequest[] = [];
  const harness = await setupChildRunHost(
    model,
    cleanup,
    { personas: [worker] },
    recordingAdmission(admissions)
  );
  const runId = await harness.start('Delegate the notes.');
  await rowsUntil(harness, harness.threadId, finished(runId), 30_000);
  await expect.poll(() => childThreads(harness)).toHaveLength(1);
  const [child = ''] = await childThreads(harness);
  await rowsUntil(harness, child, (row) => row.event.type === 'run.finished', 30_000);
  const admitted = admissions.length;

  await expect(
    harness.core().compactNow.compact({ commandId: randomUUID(), threadId: child })
  ).rejects.toMatchObject({ code: 'compaction.child-thread' });

  expect(admissions).toHaveLength(admitted);
  const rows = await harness.core().read(child, 0);
  expect(rows.filter((row) => row.event.type === 'context.compacted')).toEqual([]);
});

describe('Compact now while its summary is asked', () => {
  test('a message sent meanwhile starts from the summary, and a second request is refused', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const gate = host.hold();
    const compacting = host.compact();
    await gate.entered;

    await expect(host.compact()).rejects.toMatchObject({ code: 'compaction.in-progress' });
    const sent = host.ask('Fourth question.');
    gate.open();
    await compacting;
    await sent;

    expect(note(host.firstPrompt('Fourth question.'))).toContain(SUMMARY);
    expect(await host.compactions()).toHaveLength(1);
  });

  test('deleting the thread commits nothing and leaves nothing open', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const gate = host.hold();
    const compacting = host.compact();
    await gate.entered;

    await host.harness.core().deleteThread({ threadId: host.threadId });
    await expect(compacting).rejects.toBeDefined();
    expect(await host.compactions()).toEqual([]);
    expect(host.compactionAdmissions).toEqual({ closed: 1, opened: 1 });
  });

  test('closing the host commits nothing and leaves nothing open', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const gate = host.hold();
    const compacting = host.compact();
    await gate.entered;

    await host.harness.core().close();
    await expect(compacting).rejects.toBeDefined();
    expect(await host.compactions()).toEqual([]);
    expect(host.compactionAdmissions).toEqual({ closed: 1, opened: 1 });
  });
});
