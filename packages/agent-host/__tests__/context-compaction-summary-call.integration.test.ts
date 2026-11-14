/**
 * BST-2532: a compaction's summary call is the run's own next request, with
 * one host message after it that asks for the summary, so it reads the run's
 * cached prefix; and the summary goes into the history, not the system text,
 * so a compaction leaves the run's instructions and tools cached.
 */

import { COMPACTION_SUMMARIZER_INSTRUCTIONS } from '@brainstrike/agent/provider-runtime';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostRunAdmission } from '../src/ports.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { type ScriptedTurn, scriptedTurns } from '../src/test-fixtures/scripted-model.ts';
import {
  type CallOptions,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
} from './fixtures/child-run-host.ts';

/** One part of what a provider answers a non-streaming call with. */
type Content = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>['content'][number];

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const SUMMARY = [
  'Goal: Read the notes.',
  'Constraints: None.',
  'Decisions: None.',
  'Errors and fixes: None.',
  'State: The first reads are done.',
  'Next: Read the rest.',
].join('\n');
const INSTRUCTIONS = 'You are the coding agent.';
const QUESTION = 'Read the notes twelve times.';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
interface Call {
  readonly kind: 'generate' | 'stream';
  readonly options: CallOptions;
}

function compactions(rows: readonly HostLogRow[]): Compacted[] {
  return rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []));
}

/** The text of a prompt message's text parts. */
function text(message: CallOptions['prompt'][number] | undefined): string {
  if (!message) {
    return '';
  }
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** The usage a provider reports for the summary call: most of its input read from the cache. */
const SUMMARY_USAGE = {
  inputTokens: { cacheRead: 30_000, cacheWrite: 120, noCache: 900, total: 31_020 },
  outputTokens: { reasoning: 0, text: 210, total: 210 },
};

/**
 * A run of twelve reads of about 4,000 tokens under a 40,000-token budget: its
 * older steps compact. The run's requests stream from the script; the
 * summary call (the one non-streaming call) answers `answer`.
 */
async function summarizingHost(answer: readonly Content[]) {
  const steps: ScriptedTurn['steps'] = Array.from({ length: 12 }, () => [
    { input: { path: 'notes.md' }, toolId: 'read_file' },
  ]);
  const scripted = scriptedTurns([{ answer: 'Read them all.', prompt: QUESTION, steps }]);
  const calls: Call[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push({ kind: 'generate', options });
      return {
        content: [...answer],
        finishReason: answer.some((part) => part.type === 'tool-call')
          ? { raw: 'tool_calls', unified: 'tool-calls' }
          : { raw: 'stop', unified: 'stop' },
        usage: SUMMARY_USAGE,
        warnings: [],
      };
    },
    doStream: async (options) => {
      calls.push({ kind: 'stream', options });
      return await scripted.doStream(options);
    },
  });
  const harness = await setupChildRunHost(
    model,
    cleanup,
    { readFile: async () => ({ content: 'n'.repeat(16_000) }) },
    (platform) => async (request) => {
      const admitted = await recordingAdmission([])(platform)?.(request);
      if (!admitted) {
        throw new Error('The fixture admission admitted nothing');
      }
      return {
        ...admitted,
        inputTokenLimit: 40_000,
        // The production shape: the provider's instructions, and its request boundary.
        provider: {
          prepare: async (prepared) => ({
            messages: [...prepared.messages],
            model: admitted.model,
            system: INSTRUCTIONS,
          }),
        },
        providerRequest: { inputTokenLimit: 40_000, provider: 'openai' },
        snapshot: { ...admitted.snapshot, maxSteps: 40 },
      } satisfies HostRunAdmission;
    }
  );
  const runId = await harness.start(QUESTION);
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 30_000);
  return { calls, rows, runId };
}

/** The summary call, the run's request just before it, and its first request after it. */
function around(calls: readonly Call[]) {
  const at = calls.findIndex((call) => call.kind === 'generate');
  const summary = calls[at]?.options;
  const before = calls.slice(0, at).findLast((call) => call.kind === 'stream')?.options;
  const after = calls.slice(at + 1).find((call) => call.kind === 'stream')?.options;
  if (!(summary && before && after)) {
    throw new Error('The run made no summary call between two of its requests');
  }
  return { after, before, summary };
}

const ANSWERED: readonly Content[] = [{ text: SUMMARY, type: 'text' }];

test('the summary call is the run’s next request, with the host’s instruction after it', async () => {
  const { calls, rows } = await summarizingHost(ANSWERED);
  const { before, summary } = around(calls);

  // The run's instructions and tool definitions, and its tool choice, unchanged.
  expect(summary.tools).toEqual(before.tools);
  expect(summary.toolChoice).toEqual(before.toolChoice);
  expect(summary.prompt[0]).toEqual(before.prompt[0]);
  expect(text(summary.prompt[0])).toBe(INSTRUCTIONS);
  // Its messages open with everything the run's last request sent.
  expect(summary.prompt.slice(0, before.prompt.length)).toEqual(before.prompt);
  // Then the step that followed it, and last the host's instruction.
  const instruction = summary.prompt.at(-1);
  expect(instruction?.role).toBe('user');
  expect(text(instruction)).toContain('<brainstrike_notice>');
  expect(text(instruction)).toContain(COMPACTION_SUMMARIZER_INSTRUCTIONS);

  // The event keeps the call's own receipt, its cache read tokens included.
  expect(compactions(rows)[0]).toMatchObject({
    kind: 'agentic',
    summary: SUMMARY,
    usage: {
      inputTokenDetails: { cacheReadTokens: 30_000, cacheWriteTokens: 120 },
      inputTokens: 31_020,
      outputTokens: 210,
    },
  });
});

test('the summary is the history’s leading message, so the system text stays as it was', async () => {
  const { calls } = await summarizingHost(ANSWERED);
  const { after, before } = around(calls);

  expect(after.prompt[0]).toEqual(before.prompt[0]);
  expect(text(after.prompt[0])).not.toContain('[Earlier conversation compacted]');
  const note = after.prompt[1];
  expect(note?.role).toBe('user');
  expect(text(note)).toMatch(
    /^<brainstrike_notice>\nBrainstrike wrote this notice, not the user\./u
  );
  expect(text(note)).toContain(`[Earlier conversation compacted]\n${SUMMARY}`);
  // The person's question still opens the turn after it.
  expect(text(after.prompt[2])).toBe(QUESTION);
});

test('a summary answered with a tool call is a failed summary: the call never runs, and the fallback says why', async () => {
  const { calls, rows } = await summarizingHost([
    {
      input: JSON.stringify({ path: 'notes.md' }),
      toolCallId: 'summary-call-1',
      toolName: 'read_file',
      type: 'tool-call',
    },
  ]);
  around(calls);
  expect(compactions(rows)[0]).toMatchObject({
    kind: 'deterministic',
    summarizerFailure: { code: 'compaction.summary-tool-call' },
    usage: { inputTokenDetails: { cacheReadTokens: 30_000 } },
  });
  expect(
    rows.some(
      (row) => row.event.type === 'effect.started' && row.event.toolCallId === 'summary-call-1'
    )
  ).toBe(false);
});
