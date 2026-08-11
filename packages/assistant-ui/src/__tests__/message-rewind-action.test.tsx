/**
 * The message-level Conversation Rewind affordance (BST-1115, W5 T4).
 *
 * THE COPY IS UNDER TEST, not decoration. A rewind is inclusive of its target,
 * so "Restore to here" would be ambiguous in the direction that costs the user
 * their prompt (Amendment 2). If a future change shortens the label, this suite
 * is the thing that should stop it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockMessageState {
  readonly message: { readonly id: string; readonly role: string };
  readonly thread: { readonly isRunning: boolean };
}

let mockState: MockMessageState = {
  message: { id: 'msg-2', role: 'user' },
  thread: { isRunning: false },
};
const getCopyText = vi.fn(() => 'my original prompt');

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ message: () => ({ getCopyText }) }),
  useAuiState: <T,>(selector: (state: MockMessageState) => T) => selector(mockState),
}));

import { TooltipProvider } from '@brainstrike/ui';
import {
  MessageRewindAction,
  REWIND_ACTION_LABEL,
  selectRewindComposerText,
} from '../message-rewind-action';
import {
  type RewindContextValue,
  RewindProvider,
  type RewindRequestFromMessage,
} from '../rewind-context';

function renderAction(
  ui: ReactElement,
  rewind: RewindContextValue | null
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <RewindProvider value={rewind}>{ui}</RewindProvider>
    </TooltipProvider>
  );
}

function binding(): {
  requestRewind: ReturnType<typeof vi.fn<(r: RewindRequestFromMessage) => void>>;
} & RewindContextValue {
  return { requestRewind: vi.fn<(request: RewindRequestFromMessage) => void>() };
}

beforeEach(() => {
  mockState = { message: { id: 'msg-2', role: 'user' }, thread: { isRunning: false } };
  getCopyText.mockClear();
  getCopyText.mockReturnValue('my original prompt');
});

describe('selectRewindComposerText', () => {
  it('returns a user message’s prompt', () => {
    expect(selectRewindComposerText('user', 'redo this properly')).toBe('redo this properly');
  });

  // Amendment 2: an assistant target has no prompt to re-send, so its prose is
  // never pasted into the composer.
  it('returns null for an assistant message', () => {
    expect(selectRewindComposerText('assistant', 'here is what I did')).toBeNull();
  });

  it('returns null for whitespace-only text, never an empty repopulation', () => {
    expect(selectRewindComposerText('user', '   \n ')).toBeNull();
  });
});

describe('MessageRewindAction', () => {
  it('reads "Restore to before this message", never "Restore to here"', () => {
    renderAction(<MessageRewindAction threadId="thread-1" />, binding());

    const action = screen.getByTestId('message-rewind-action');
    expect(action).toHaveTextContent(REWIND_ACTION_LABEL);
    expect(REWIND_ACTION_LABEL).toBe('Restore to before this message');
    expect(action).not.toHaveTextContent('Restore to here');
  });

  it('raises the rewind with the message id and the target’s own prompt', () => {
    const rewind = binding();
    renderAction(<MessageRewindAction threadId="thread-1" />, rewind);

    fireEvent.click(screen.getByTestId('message-rewind-action'));

    expect(rewind.requestRewind).toHaveBeenCalledWith({
      composerText: 'my original prompt',
      messageId: 'msg-2',
      threadId: 'thread-1',
    });
  });

  it('renders null without a RewindProvider binding (web / no changes bridge)', () => {
    const { container } = renderAction(<MessageRewindAction threadId="thread-1" />, null);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders null when the active thread id is unknown', () => {
    const { container } = renderAction(<MessageRewindAction threadId={undefined} />, binding());

    expect(container).toBeEmptyDOMElement();
  });

  // The affordance is user-messages-only: rewinding to an assistant message
  // has no prompt to restore and no obvious meaning to the reader.
  it('renders null on an assistant message', () => {
    mockState = { message: { id: 'msg-3', role: 'assistant' }, thread: { isRunning: false } };
    const { container } = renderAction(<MessageRewindAction threadId="thread-1" />, binding());

    expect(container).toBeEmptyDOMElement();
  });

  // Safety gate, not cosmetics: reverting files a live run is still writing
  // would race the run's own journal entries.
  it('renders null while a run is in flight', () => {
    mockState = { message: { id: 'msg-2', role: 'user' }, thread: { isRunning: true } };
    const { container } = renderAction(<MessageRewindAction threadId="thread-1" />, binding());

    expect(container).toBeEmptyDOMElement();
  });
});
