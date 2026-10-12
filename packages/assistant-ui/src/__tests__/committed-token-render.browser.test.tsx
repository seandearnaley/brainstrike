import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (see its header).
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import { expect, onTestFinished, test } from 'vitest';
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
} from './committed-assistant-browser-support';
import { publishLiveText } from './committed-live-text-support';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * BST-1929 correction 8, pinned by the React DevTools did-render rule: the
 * committed wrapper subscribes only to connection and error state, so a
 * recorded token does not re-render it. Only the vendor runtime's host below
 * it observes every publication.
 */
test('a recorded token does not re-render the committed wrapper', async () => {
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(answerStepLength);
  const store = await recordedStore(source, baseline);
  onTestFinished(() => store.dispose());
  // The answer's text part exists, still empty: its recorded live text-start.
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
  const token = await measurePublication(() => publishLiveText(store, 'text-delta'), true);

  // Non-vacuous: the walk saw the token render its own streaming row and
  // components outside any row.
  expect(Object.keys(token.rendersByOwner[recordedRunId] ?? {})).not.toEqual([]);
  const outside = token.rendersByOwner['outside'] ?? {};
  expect(Object.keys(outside)).not.toEqual([]);
  expect(outside['BoundCommittedAssistantConversation']).toBeUndefined();
});
