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
  RecordedCommittedSource,
  recordedBaseline,
  recordedPrompt,
  recordedStore,
  rejectingNew,
  setActEnvironment,
  settleAnimations,
  waitForQuiescence,
} from './committed-assistant-browser-support';
import { publishLiveText, TEXT_TELEMETRY } from './committed-live-text-support';
import { LONG_REPLY_LONGEST_BLOCK, LONG_REPLY_TOKENS } from './long-markdown-reply';
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

/**
 * BST-1929: every streamed token used to re-parse the whole reply, so the
 * per-token cost grew with the reply's length (react-markdown at p95 19 ms per
 * token at the end of an 11.4k-character reply, against the 8 ms budget).
 * Streamdown memoizes each finished block: a token re-parses only the block it
 * lands in. So the largest text parsed while a token lands is one block, at 10%
 * of the reply and at its end alike.
 */
test('a streamed token re-parses only the open block, however long the reply grows', async () => {
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
  const publishThrough = async (end: number): Promise<void> => {
    store.acceptTelemetry(runId, { ...chunk, text: LONG_REPLY_TOKENS.slice(cursor, end).join('') });
    cursor = end;
    // Quiescence includes the vendor's frame-paced smooth reveal.
    await waitForQuiescence();
  };
  const largestParseWhileTokensLand = async (): Promise<number> => {
    parses.lengths.length = 0;
    for (const end = cursor + WINDOW_TOKENS; cursor < end; ) {
      await publishThrough(cursor + 1);
    }
    // Non-vacuous: the tokens really were parsed.
    expect(parses.lengths.length).toBeGreaterThan(0);
    return Math.max(...parses.lengths);
  };

  const largest: Record<string, number> = {};
  for (const [label, fraction] of [
    ['10%', 0.1],
    ['50%', 0.5],
    ['end', 1],
  ] as const) {
    await publishThrough(Math.floor(LONG_REPLY_TOKENS.length * fraction) - WINDOW_TOKENS);
    largest[label] = await largestParseWhileTokensLand();
  }

  // A block plus the closing markers the renderer adds to an unfinished one.
  const oneBlock = LONG_REPLY_LONGEST_BLOCK + 16;
  console.info('LONG_REPLY_LARGEST_PARSE', JSON.stringify({ largest, oneBlock }));
  const overOneBlock = Object.entries(largest).filter(([, size]) => size > oneBlock);
  expect(overOneBlock, `largest parse per window ${JSON.stringify(largest)}`).toEqual([]);
}, 60_000);
