import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (see its header).
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import {
  answerStepLength,
  instrumentation,
  measurePublication,
  RecordedCommittedSource,
  recordedBaseline,
  recordedPrompt,
  recordedRunId,
  recordedStore,
  rejectingNew,
  setActEnvironment,
  settleAnimations,
  waitForQuiescence,
} from './committed-assistant-browser-support';
import { publishLiveText, TEXT_TELEMETRY } from './committed-live-text-support';
import { LONG_REPLY_FOOTNOTE_TOKEN, LONG_REPLY_TOKENS } from './long-markdown-reply';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

const parses = vi.hoisted(() => ({ lengths: [] as number[] }));

// Observe every markdown parse. MarkdownText's remark-gfm plugin runs once per
// parse, and its transformer receives the parsed text as the file, whichever
// renderer drives it. The real plugin still registers its syntax.
vi.mock('remark-gfm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remark-gfm')>();
  return {
    default(this: ThisParameterType<typeof actual.default>, options?: object) {
      actual.default.call(this, options);
      return (_tree: unknown, file: { readonly value: unknown }) => {
        parses.lengths.push(String(file.value).length);
      };
    },
  };
});

const WINDOW_TOKENS = 12;

/** A token that opens a new prose paragraph: a blank line, then a capital letter. */
const PARAGRAPH_START = /^\n\n[A-Z]/;

/** Tokens until the next blank line, i.e. how long the paragraph opened at `start` streams. */
function paragraphTokens(start: number): number {
  const next = LONG_REPLY_TOKENS.findIndex(
    (token, index) => index > start && token.includes('\n\n')
  );
  return (next === -1 ? LONG_REPLY_TOKENS.length : next) - start;
}

/**
 * Where to measure: the second token of a prose paragraph long enough for a
 * whole window, so every measured token extends the same open block and the
 * three windows parse comparable text. `end` takes the last such paragraph
 * that finishes streaming before the reply's closing footnote: from a footnote
 * on, Streamdown keeps references and definitions together by parsing the
 * whole reply as one block (a known vendor behaviour, documented in BST-1929).
 */
function windowStarts(): Readonly<Record<'10%' | '50%' | 'end', number>> {
  const starts = LONG_REPLY_TOKENS.flatMap((token, index) =>
    PARAGRAPH_START.test(token) &&
    paragraphTokens(index) > WINDOW_TOKENS + 1 &&
    index + 1 + WINDOW_TOKENS <= LONG_REPLY_FOOTNOTE_TOKEN
      ? [index + 1]
      : []
  );
  const from = (fraction: number): number => {
    const start = starts.find((index) => index >= LONG_REPLY_TOKENS.length * fraction);
    if (start === undefined) {
      throw new Error(`No prose paragraph starts after ${fraction * 100}% of the reply.`);
    }
    return start;
  };
  const end = starts.at(-1);
  if (end === undefined) {
    throw new Error('The long reply has no prose paragraph long enough to measure.');
  }
  return { '10%': from(0.1), '50%': from(0.5), end };
}

/** No commit for this long means the prefix's asynchronous work has finished. */
const IDLE_MS = 500;
const IDLE_LIMIT_MS = 15_000;

async function waitForIdle(quietMs: number): Promise<void> {
  const started = performance.now();
  let commits = instrumentation.commits;
  let since = performance.now();
  for (;;) {
    await waitForQuiescence();
    if (instrumentation.commits !== commits) {
      commits = instrumentation.commits;
      since = performance.now();
    } else if (performance.now() - since >= quietMs) {
      return;
    }
    if (performance.now() - started > IDLE_LIMIT_MS) {
      throw new Error(`The conversation kept committing for ${IDLE_LIMIT_MS} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

interface TokenWork {
  /** Commits the token caused anywhere, and those that rendered the streaming message. */
  readonly commits: number;
  readonly messageCommits: number;
  readonly parsedCharacters: number;
  /** Markdown parses the token caused, and the characters they parsed. */
  readonly parses: number;
}

/**
 * BST-1929: every streamed token used to re-parse the whole reply and re-render
 * on every reveal frame, so its cost grew with the reply's length (p95 28 ms at
 * the end of an 11.4k-character reply on main, against an 8 ms budget).
 * Streamdown memoizes each finished block and reveals words with CSS, so the
 * work a token causes is structural and the same at any length: one parse of
 * the open block, one commit of the streaming message.
 */
test('a streamed token costs the same parse and commits at 10% of a long reply and at its end', async () => {
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(answerStepLength);
  const store = await recordedStore(source, baseline);
  onTestFinished(() => store.dispose());
  publishLiveText(store, 'text-start');
  render(
    <TooltipProvider>
      <div style={{ height: 620, width: 900 }}>
        <CommittedAssistantConversation
          commands={{ onNew: rejectingNew() }}
          label="Committed conversation"
          store={store}
        />
      </div>
    </TooltipProvider>
  );
  const region = screen.getByRole('region', { name: 'Committed conversation' });
  await within(region).findByText(recordedPrompt);
  await settleAnimations(region);
  instrumentation.assertInstalled();
  const previousActEnvironment = setActEnvironment(false);
  onTestFinished(() => {
    setActEnvironment(previousActEnvironment);
  });

  // The recorded run's own live text-delta chunk, carrying the long reply's text.
  const { chunk, runId } = TEXT_TELEMETRY['text-delta'];
  let cursor = 0;
  const publish = (end: number): void => {
    store.acceptTelemetry(runId, { ...chunk, text: LONG_REPLY_TOKENS.slice(cursor, end).join('') });
    cursor = end;
  };
  const tokensFrom = async (start: number): Promise<readonly TokenWork[]> => {
    publish(start);
    // Code blocks in the prefix highlight asynchronously (Shiki, after a short
    // delay); let that finish so its commits are not counted as a token's.
    await waitForIdle(IDLE_MS);
    const work: TokenWork[] = [];
    for (const end = start + WINDOW_TOKENS; cursor < end; ) {
      parses.lengths.length = 0;
      const timing = await measurePublication(() => publish(cursor + 1), true);
      work.push({
        commits: timing.commits,
        messageCommits: timing.commitsByOwner[recordedRunId] ?? 0,
        parsedCharacters: parses.lengths.reduce((total, length) => total + length, 0),
        parses: parses.lengths.length,
      });
    }
    return work;
  };

  const windows: Partial<Record<keyof ReturnType<typeof windowStarts>, readonly TokenWork[]>> = {};
  for (const [label, start] of Object.entries(windowStarts()) as [
    keyof ReturnType<typeof windowStarts>,
    number,
  ][]) {
    windows[label] = await tokensFrom(start);
  }
  console.info('LONG_REPLY_TOKEN_WORK', JSON.stringify(windows));

  const all = Object.values(windows).flat();
  // Finished blocks are not parsed again while the reply streams: each token
  // parses exactly one block, the open one.
  expect(all.map((token) => token.parses)).toEqual(all.map(() => 1));
  // The streaming message renders in exactly one commit per token, and the
  // token's commits overall do not change with the reply's length.
  expect(all.map((token) => token.messageCommits)).toEqual(all.map(() => 1));
  expect(new Set(all.map((token) => token.commits)).size).toBe(1);
  // Parse work per token at the end is at most 1.5x what it is at 10%.
  const parsed = (label: keyof typeof windows): number =>
    median((windows[label] ?? []).map((token) => token.parsedCharacters));
  expect(parsed('end')).toBeLessThanOrEqual(1.5 * parsed('10%'));
}, 60_000);
