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

/** Holds a call until `open`, or until its signal aborts; `entered` settles once a call waits. */
interface Gate {
  readonly entered: Promise<void>;
  readonly open: () => void;
  readonly wait: (signal: AbortSignal | undefined) => Promise<void>;
}

function gate(): Gate {
  const entered = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    open: opened.resolve,
    wait: (signal) => {
      entered.resolve();
      return new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        void opened.promise.then(resolve);
      });
    },
  };
}

/**
 * A thread host whose summary call answers `SUMMARY`. A compaction's admission
 * or summary call can be held at a gate, and its admission's close can fail.
 * Each run's first request is kept by prompt.
 */
async function compactingHost() {
  const scripted = scriptedTurns([...QUESTIONS.map(turn), SHORT], SUMMARY);
  const summaries: CallOptions[] = [];
  const firstRequests = new Map<string, CallOptions>();
  const control: {
    admission?: Gate;
    answer: string | undefined;
    closeFails: boolean;
    credential: boolean;
    summary?: Gate;
  } = { answer: undefined, closeFails: false, credential: true };
  const compactionAdmissions = { closed: 0, opened: 0 };
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      summaries.push(options);
      await control.summary?.wait(options.abortSignal);
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
      if (compaction) {
        await control.admission?.wait(request.signal);
      }
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
                if (control.closeFails) {
                  throw new Error('The compaction admission did not close');
                }
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
  /** Holds the next compaction's admission, or its summary call, until the gate opens. */
  const hold = (at: 'admission' | 'summary' = 'summary'): Gate => {
    const held = gate();
    control[at] = held;
    return held;
  };
  /** How many runs the thread's committed log started. */
  const started = async (): Promise<number> =>
    (await harness.core().read(threadId, 0)).filter((row) => row.event.type === 'run.started')
      .length;
  /** What a run/start, a regenerate and a rewind of the message `answered` get now. */
  const tryEach = (answered: string) =>
    Promise.allSettled([
      harness.core().startRun({
        commandId: randomUUID(),
        modelId: MODEL,
        prompt: 'Fourth question.',
        threadId,
      }),
      harness.core().regenerateRun({
        commandId: randomUUID(),
        modelId: MODEL,
        threadId,
        userMessageId: answered,
      }),
      harness.core().rewinds.rewind({
        commandId: randomUUID(),
        messageId: answered,
        mode: 'conversation-only',
        threadId,
      }),
    ]);
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
    started,
    summaries,
    threadId,
    tryEach,
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

/**
 * What a settled attempt was refused with, or `started` when it was not
 * refused. A run that was not admitted carries its refusal as its cause, as
 * the wire does.
 */
function refusalCode(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') {
    return 'started';
  }
  const refused = result.reason as {
    readonly cause?: { readonly code?: unknown };
    readonly code?: unknown;
  };
  return String(refused.code ?? refused.cause?.code);
}
const IN_PROGRESS = ['compaction.in-progress', 'compaction.in-progress', 'compaction.in-progress'];

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
  test('a run/start that reached the host first starts, and the compaction is refused as a run', {
    timeout: 60_000,
  }, async () => {
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
    expect(await host.compactions()).toEqual([]);
  });

  test('during its admission, a run/start, regenerate and rewind are refused as in progress, and start nothing', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const runs = await host.started();
    const admission = host.hold('admission');
    const compacting = host.compact();
    await admission.entered;

    const attempts = host.tryEach(host.commands.get('Third question.') ?? '');
    admission.open();
    expect((await attempts).map(refusalCode)).toEqual(IN_PROGRESS);
    await compacting;
    expect(await host.started()).toBe(runs);
    expect(await host.compactions()).toHaveLength(1);
  });

  test('during its summary, a run/start, regenerate, rewind and a second compaction are refused as in progress; once it commits, the next run starts from the summary', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const runs = await host.started();
    const summary = host.hold('summary');
    const compacting = host.compact();
    await summary.entered;

    const attempts = await host.tryEach(host.commands.get('Third question.') ?? '');
    expect(attempts.map(refusalCode)).toEqual(IN_PROGRESS);
    await expect(host.compact()).rejects.toMatchObject({ code: 'compaction.in-progress' });
    summary.open();
    await compacting;
    expect(await host.started()).toBe(runs);

    await host.ask('Fourth question.');
    expect(note(host.firstPrompt('Fourth question.'))).toContain(SUMMARY);
    expect(await host.compactions()).toHaveLength(1);
  });

  test('a person’s input sent meanwhile stays queued, and its run starts from the summary', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    const runs = await host.started();
    const summary = host.hold('summary');
    const compacting = host.compact();
    await summary.entered;

    // A person's message to the idle thread wakes it; the wake leaves it queued.
    await host.harness.core().input({
      commandId: randomUUID(),
      modelId: MODEL,
      prompt: 'Fourth question.',
      runId: host.runs[2] ?? '',
      threadId: host.threadId,
    });
    await host.harness.core().idle(host.threadId);
    expect(await host.started()).toBe(runs);
    summary.open();
    await compacting;

    // Once the compaction commits, the thread wakes for it: one run, which completes.
    await expect.poll(() => host.started(), { timeout: 30_000 }).toBe(runs + 1);
    const woke = (await host.harness.core().read(host.threadId, 0)).findLast(
      (row) => row.event.type === 'run.started'
    )?.event;
    if (woke?.type !== 'run.started') {
      throw new Error('No run started for the queued input');
    }
    const rows = await rowsUntil(host.harness, host.threadId, finished(woke.runId), 30_000);
    expect(rows.find((row) => finished(woke.runId)(row))?.event).toMatchObject({
      outcome: 'completed',
    });
    expect(note(host.firstPrompt('Fourth question.'))).toContain(SUMMARY);
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

  test('an admission that does not close is a failed cleanup the thread keeps, as a run’s is', {
    timeout: 60_000,
  }, async () => {
    const host = await threeTurns();
    host.control.closeFails = true;

    const failure: unknown = await host.compact().catch((cause: unknown) => cause);
    expect(String(failure)).toContain('The compaction admission did not close');
    // The thread's next command meets it, and so does the host's close.
    await expect(
      host.harness.core().startRun({
        commandId: randomUUID(),
        modelId: MODEL,
        prompt: 'Fourth question.',
        threadId: host.threadId,
      })
    ).rejects.toBe(failure);
    await expect(host.harness.core().close()).rejects.toThrow('Host cleanup failed');
    // A fresh host over the same store, so the harness closes cleanly.
    await host.harness.crash();
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
