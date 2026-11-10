import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (see its header).
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import { expect, onTestFinished, test } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import {
  answerStepLength,
  RecordedCommittedSource,
  recordedBaseline,
  recordedPrompt,
  recordedStore,
  rejectingNew,
  settleAnimations,
  waitForQuiescence,
} from './committed-assistant-browser-support';
import { publishLiveText, TEXT_TELEMETRY } from './committed-live-text-support';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/** The animations a reply's revealed words still hold, running or finished. */
function wordAnimations(region: Element): Animation[] {
  return region.getAnimations({ subtree: true }).filter((animation) => {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return target?.hasAttribute('data-sd-animate') === true;
  });
}

/**
 * A streaming reply keeps every word of its open blocks in a reveal span. The
 * vendor stylesheet fills each word's fade forwards, which holds the finished
 * animation (and the compositor layer it promoted the word to) for as long as
 * the span exists: 1,100 live animations and 100 extra layers half-way through
 * a 24k-character reply. A word that has finished fading in holds nothing.
 */
test('a revealed word releases its animation while the reply still streams', async () => {
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

  const { chunk, runId } = TEXT_TELEMETRY['text-delta'];
  store.acceptTelemetry(runId, { ...chunk, text: 'Five words fade in here' });
  await waitForQuiescence();
  // Non-vacuous: the words are in reveal spans, and they do fade in.
  await expect.poll(() => region.querySelectorAll('[data-sd-animate]').length).toBe(5);
  expect(wordAnimations(region).map((animation) => animation.playState)).toContain('running');

  await settleAnimations(region);
  // The reply is still streaming, so the spans are still there, fully shown.
  const words = [...region.querySelectorAll('[data-sd-animate]')];
  expect(words).toHaveLength(5);
  expect(words.map((word) => getComputedStyle(word).opacity)).toEqual(words.map(() => '1'));
  expect(wordAnimations(region)).toEqual([]);
});
