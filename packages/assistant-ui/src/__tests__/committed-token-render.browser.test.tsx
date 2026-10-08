import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (see its header).
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import { expect, onTestFinished, test } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import {
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
  TEXT_ROW,
} from './committed-assistant-browser-support';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * BST-1929 correction 8's cause, pinned by the React DevTools did-render rule:
 * the committed wrapper subscribes only to connection and error state, and the
 * vendor runtime's host passes no token-dependent prop to the panel, so a
 * recorded token re-renders neither the wrapper nor the panel shell.
 */
const PANEL_SHELL = [
  'BoundCommittedAssistantConversation',
  'AssistantConversationPanel',
  'ChatThreadUI',
  'ComposerInputRow',
] as const;

test('a recorded token re-renders neither the committed wrapper nor the panel shell', async () => {
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(TEXT_ROW['text-start'] + 1);
  const store = await recordedStore(source, baseline);
  onTestFinished(() => store.dispose());
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
  const token = await measurePublication(
    () => source.publishPrefix(TEXT_ROW['text-delta'] + 1),
    true
  );

  // Non-vacuous: the walk saw the token render its own streaming row.
  expect(Object.keys(token.rendersByOwner[recordedRunId] ?? {})).not.toEqual([]);
  const outside = token.rendersByOwner['outside'] ?? {};
  expect(PANEL_SHELL.filter((name) => name in outside)).toEqual([]);
});
