// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { type ComposerDraftChannel, useComposerDraftChannel } from '../use-composer-draft-channel';

beforeEach(() => {
  useAssistantComposerCommandStore.getState().reset();
});
afterEach(cleanup);

/** A composer as assistant-ui mounts one: empty, and its text recorded from its own effect. */
function Composer({ channel }: { readonly channel: ComposerDraftChannel }) {
  const { command, onTextChange } = channel;
  useEffect(() => {
    onTextChange(command?.text ?? '');
  }, [command, onTextChange]);
  return <output aria-label="composer">{command?.text ?? ''}</output>;
}

function Panel({ threadId }: { readonly threadId: string }) {
  const channel = useComposerDraftChannel(threadId);
  return <Composer channel={channel} />;
}

it('gives a composer mounted again the text it had not sent', () => {
  useAssistantComposerCommandStore
    .getState()
    .recordDraft('new-thread:workspace', 'Plan the release');

  render(<Panel threadId="new-thread:workspace" />);

  expect(screen.getByRole('status', { name: 'composer' })).toHaveTextContent('Plan the release');
  expect(useAssistantComposerCommandStore.getState().draftTextByThreadId).toEqual({
    'new-thread:workspace': 'Plan the release',
  });
});

it('mounts empty once the draft was sent', () => {
  useAssistantComposerCommandStore.getState().recordDraft('new-thread:workspace', '');

  render(<Panel threadId="new-thread:workspace" />);

  expect(screen.getByRole('status', { name: 'composer' })).toBeEmptyDOMElement();
  expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
});
