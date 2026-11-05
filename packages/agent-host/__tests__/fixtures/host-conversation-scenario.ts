/**
 * Generated conversations driven through a real HostCore over a real
 * StateStore with a scripted model, for model-based tests (ADR-0011).
 *
 * `hostScenario()` generates commands a person can give one thread: start a
 * run (after the tip, at the root, or after any earlier run), regenerate a
 * committed user message, rewind the conversation to before one, redo that
 * rewind, and reopen the host over the same store. Each run's script picks its
 * tool turns: a read that runs at once, a command the person approves or
 * denies, a question the person answers, or a Stop while it waits.
 *
 * `runHostScenario` applies them one at a time, keeping a reference model of
 * the conversation tree beside the host. Every model request a run makes first
 * is checked against the reference path, so a sibling branch, a lost reply or
 * a misplaced tip shows up as the turn the host sent. At each reopen the
 * closing host's reads are checked against the reopened host's. The committed
 * rows it returns are valid host logs by construction: other tests can fold
 * them, or start from them.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import fc from 'fast-check';
import { expect } from 'vitest';
import type { HostCore } from '../../src/core.js';
import type { HostLogRow } from '../../src/protocol.js';
import {
  type CallOptions,
  type ChildRunHarness,
  type Chunk,
  setupChildRunHost,
  stream,
  text,
  toolCall,
} from './child-run-host.js';

/** One tool turn of a run: what the model calls, and how the person answers. */
export type ScenarioToolTurn = 'read' | 'approve' | 'deny' | 'answer';

export interface ScenarioRunScript {
  /** Ends the run with Stop at its first waiting request, when it has one. */
  readonly stopWhenAsked: boolean;
  readonly tools: readonly ScenarioToolTurn[];
}

/** An index picks an earlier item modulo the count, so every generated command applies. */
export type ScenarioCommand =
  | {
      readonly kind: 'start';
      readonly parent: 'tip' | 'root' | { readonly after: number };
      readonly script: ScenarioRunScript;
    }
  | { readonly kind: 'regenerate'; readonly message: number; readonly script: ScenarioRunScript }
  | { readonly kind: 'rewind'; readonly message: number }
  | { readonly kind: 'redo' }
  | { readonly kind: 'reopen' };

const script: fc.Arbitrary<ScenarioRunScript> = fc.record({
  stopWhenAsked: fc.boolean(),
  tools: fc.array(fc.constantFrom<ScenarioToolTurn>('read', 'approve', 'deny', 'answer'), {
    maxLength: 2,
  }),
});

export function hostScenario(
  options: { readonly maxCommands?: number } = {}
): fc.Arbitrary<ScenarioCommand[]> {
  const command: fc.Arbitrary<ScenarioCommand> = fc.oneof(
    {
      arbitrary: fc.record({
        kind: fc.constant('start' as const),
        parent: fc.oneof(
          fc.constant('tip' as const),
          fc.constant('root' as const),
          fc.record({ after: fc.nat() })
        ),
        script,
      }),
      weight: 4,
    },
    {
      arbitrary: fc.record({ kind: fc.constant('regenerate' as const), message: fc.nat(), script }),
      weight: 2,
    },
    {
      arbitrary: fc.record({ kind: fc.constant('rewind' as const), message: fc.nat() }),
      weight: 1,
    },
    { arbitrary: fc.constant({ kind: 'redo' as const }), weight: 1 },
    { arbitrary: fc.constant({ kind: 'reopen' as const }), weight: 2 }
  );
  return fc.array(command, { maxLength: options.maxCommands ?? 8, minLength: 1 });
}

/** One run as the reference model holds it. */
interface ReferenceRun {
  readonly parent: string | null;
  readonly prompt: string;
  /** The assistant text the run committed: its final reply, when it gave one. */
  reply: string | undefined;
  readonly runId: string;
  readonly userMessageId: string;
}

/** What a model request carried, as text turns: system turns and tool exchanges are left out. */
export interface PromptTurn {
  readonly role: 'assistant' | 'user';
  readonly text: string;
}

export function promptTurns(call: Pick<CallOptions, 'prompt'>): PromptTurn[] {
  return call.prompt.flatMap((message): PromptTurn[] => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    return content ? [{ role: message.role, text: content }] : [];
  });
}

/** Every read a client makes of a thread that is not its row log. */
async function hostReads(core: HostCore, threadId: string) {
  return {
    ledger: core.readLedger(),
    selection: core.selections.read(threadId),
    threads: core.listThreads(),
    tree: core.trees.read(threadId),
  };
}

/** The first committed row, from `fromSeq` on, that `done` accepts. */
async function committed(
  harness: ChildRunHarness,
  done: (row: HostLogRow) => boolean
): Promise<HostLogRow> {
  const core = harness.core();
  const seen = Promise.withResolvers<HostLogRow>();
  const release = core.onCommitted((row) => {
    if (row.threadId === harness.threadId && done(row)) {
      seen.resolve(row);
    }
  });
  try {
    const existing = (await core.read(harness.threadId, 0)).find(done);
    if (existing) {
      return existing;
    }
    return await seen.promise;
  } finally {
    release();
  }
}

export interface HostScenarioResult {
  readonly calls: readonly CallOptions[];
  /** The thread's rows as each host published them to a live subscriber, in order. */
  readonly published: readonly HostLogRow[];
  readonly rows: readonly HostLogRow[];
  readonly threadId: string;
}

/**
 * Apply `commands` to a fresh host, checking each run's first request against
 * the reference path and each reopen against the closing host's reads.
 * `cleanup` receives the harness teardown.
 */
export async function runHostScenario(
  commands: readonly ScenarioCommand[],
  cleanup: (() => Promise<void>)[],
  options: {
    /**
     * KNOWN BUG (live-reopen-fold.test.ts pins it): a live host never folds its
     * own run.started into the thread's rewind, so after a rewind every later
     * start at the tip still branches from the rewound head, and a rewind to a
     * message sent since is refused as off the branch, until a reopen. While it
     * stands, such a start names the reference tip as its parent and such a
     * rewind is skipped, so generated scenarios keep checking everything else.
     * Pass `exercise` to reproduce it; delete this option with the BST-2459 fix.
     */
    readonly liveRewindTip?: 'avoid' | 'exercise';
  } = {}
): Promise<HostScenarioResult> {
  const queued: Chunk[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const next = queued.shift();
      if (!next) {
        throw new Error('The scenario scripted no further model response');
      }
      return stream(next);
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const { threadId } = harness;
  const published: HostLogRow[] = await harness.core().read(threadId, 0);
  const subscribe = (core: HostCore): void => {
    cleanup.push(async () => {
      release();
    });
    const release = core.onCommitted((row) => {
      if (row.threadId === threadId) {
        published.push(row);
      }
    });
  };
  subscribe(harness.core());
  const runs: ReferenceRun[] = [];
  let rewind: { current: boolean; headId: string | null; rewindId: string } | undefined;
  /** A run started after the latest rewind since this host opened (the known bug's trigger). */
  let rewindConsumedLive = false;
  let prompts = 0;

  const tip = (): string | null => {
    if (rewind?.current) {
      return rewind.headId;
    }
    return runs.at(-1)?.runId ?? null;
  };
  const byId = (runId: string | null): ReferenceRun | undefined =>
    runs.find((run) => run.runId === runId);
  const path = (head: string | null): ReferenceRun[] => {
    const chain: ReferenceRun[] = [];
    for (let run = byId(head); run; run = byId(run.parent)) {
      chain.unshift(run);
    }
    return chain;
  };
  const expectedTurns = (parent: string | null, prompt: string): PromptTurn[] => [
    ...path(parent).flatMap((run): PromptTurn[] => [
      { role: 'user', text: run.prompt },
      ...(run.reply ? [{ role: 'assistant' as const, text: run.reply }] : []),
    ]),
    { role: 'user', text: prompt },
  ];
  const userMessages = (): ReferenceRun[] =>
    runs.filter(
      (run, index) => runs.findIndex((other) => other.userMessageId === run.userMessageId) === index
    );

  /** Script the model, start the run, and see it through its waits to its end. */
  const drive = async (
    plan: ScenarioRunScript,
    parent: string | null,
    prompt: string,
    start: () => Promise<{ commandId: string; runId: string }>
  ): Promise<void> => {
    const reply = `Reply ${runs.length + 1}.`;
    plan.tools.forEach((tool, index) => {
      const id = `call-${runs.length + 1}-${index}`;
      queued.push(
        tool === 'read'
          ? toolCall('read_file', { path: 'notes.md' }, id)
          : tool === 'answer'
            ? toolCall('ask_user', { question: 'Which file?' }, id)
            : toolCall('run_command', { command: 'echo scenario' }, id)
      );
    });
    queued.push(text(reply));
    const before = model.doStreamCalls.length;
    const { commandId, runId } = await start();
    const run: ReferenceRun = { parent, prompt, reply: undefined, runId, userMessageId: commandId };
    runs.push(run);
    if (rewind) {
      rewindConsumedLive ||= rewind.current;
      rewind.current = false;
    }
    const answered = new Set<string>();
    const approvals = plan.tools.filter((tool) => tool === 'approve' || tool === 'deny');
    for (;;) {
      const { event } = await committed(
        harness,
        ({ event }) =>
          (event.type === 'run.finished' && event.runId === runId) ||
          (event.type === 'interaction.requested' &&
            event.runId === runId &&
            !answered.has(event.interactionId))
      );
      if (event.type === 'run.finished') {
        if (event.outcome === 'completed') {
          run.reply = reply;
        }
        break;
      }
      if (event.type !== 'interaction.requested') {
        throw new Error('Unreachable scenario row');
      }
      answered.add(event.interactionId);
      const core = harness.core();
      if (plan.stopWhenAsked) {
        await core.stop({ commandId: randomUUID(), runId, threadId });
      } else if (event.kind === 'question') {
        await core.resume({
          commandId: randomUUID(),
          interactionId: event.interactionId,
          resumeData: { answer: 'notes.md' },
          runId,
          threadId,
        });
      } else {
        await core.respond({
          commandId: randomUUID(),
          decision: approvals.shift() === 'deny' ? 'deny' : 'approve',
          interactionId: event.interactionId,
          runId,
          threadId,
        });
      }
    }
    queued.length = 0;
    const first = model.doStreamCalls[before];
    if (first) {
      expect(promptTurns(first), `run ${runs.length}'s first request`).toEqual(
        expectedTurns(parent, prompt)
      );
    }
    prompts += 1;
  };

  for (const command of commands) {
    const core = harness.core();
    switch (command.kind) {
      case 'start': {
        const prompt = `Prompt ${prompts + 1}.`;
        const after =
          typeof command.parent === 'object' && runs.length > 0
            ? runs[command.parent.after % runs.length]?.runId
            : undefined;
        const avoided =
          command.parent === 'tip' && rewindConsumedLive && options.liveRewindTip !== 'exercise';
        const requested = command.parent === 'root' ? null : avoided ? tip() : after;
        const parent = requested === undefined ? tip() : requested;
        await drive(command.script, parent, prompt, async () => {
          const commandId = randomUUID();
          const { runId } = await core.startRun({
            commandId,
            modelId: 'scripted',
            ...(requested === undefined ? {} : { parentMessageId: requested }),
            prompt,
            threadId,
          });
          return { commandId, runId };
        });
        break;
      }
      case 'regenerate': {
        const messages = userMessages();
        const target = messages[command.message % Math.max(messages.length, 1)];
        if (!target) {
          break;
        }
        await drive(command.script, target.parent, target.prompt, async () => {
          const { runId } = await core.regenerateRun({
            commandId: randomUUID(),
            modelId: 'scripted',
            threadId,
            userMessageId: target.userMessageId,
          });
          return { commandId: target.userMessageId, runId };
        });
        break;
      }
      case 'rewind': {
        if (rewindConsumedLive && options.liveRewindTip !== 'exercise') {
          break;
        }
        const branch = path(tip());
        const target = branch[command.message % Math.max(branch.length, 1)];
        if (!target) {
          break;
        }
        const result = await core.rewinds.rewind({
          commandId: randomUUID(),
          messageId: target.userMessageId,
          mode: 'conversation-only',
          threadId,
        });
        if (result.status !== 'rewound') {
          throw new Error(`A conversation-only rewind ended ${result.status}`);
        }
        rewind = { current: true, headId: target.parent, rewindId: result.rewindId };
        rewindConsumedLive = false;
        break;
      }
      case 'redo': {
        if (!rewind?.current) {
          break;
        }
        const result = await core.rewinds.redo({
          commandId: randomUUID(),
          rewindId: rewind.rewindId,
          threadId,
        });
        if (result.status !== 'redone') {
          throw new Error(`A conversation-only redo ended ${result.status}`);
        }
        rewind = undefined;
        break;
      }
      case 'reopen': {
        const live = await hostReads(core, threadId);
        await harness.crash();
        subscribe(harness.core());
        rewindConsumedLive = false;
        expect(await hostReads(harness.core(), threadId), 'reads after reopen').toEqual(live);
        break;
      }
    }
  }
  return {
    calls: model.doStreamCalls,
    published,
    rows: await harness.core().read(threadId, 0),
    threadId,
  };
}
