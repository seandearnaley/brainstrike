/**
 * Composer repopulation after a Conversation Rewind (BST-1115, Amendment 2).
 *
 * The producing modal lives in another package and the button that raised the
 * rewind is unmounted by the rewind itself, so the handoff goes through a
 * module-scope store drained by this render-nothing bridge. What is under test
 * is that the drain happens exactly once and only for real text.
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setText = vi.fn();
vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText }) }),
}));

import { RewindComposerBridge } from '../message-rewind-action';
import { useRewindComposerStore } from '../rewind-composer-store';

beforeEach(() => {
  useRewindComposerStore.getState().consume();
  setText.mockClear();
});

describe('useRewindComposerStore', () => {
  it('refuses whitespace-only text rather than storing an empty repopulation', () => {
    expect(() => useRewindComposerStore.getState().requestComposerText('   ')).toThrow(
      /non-whitespace/
    );
    expect(useRewindComposerStore.getState().pendingText).toBeNull();
  });

  it('keeps only the newest request — an abandoned handoff never queues up', () => {
    useRewindComposerStore.getState().requestComposerText('first');
    useRewindComposerStore.getState().requestComposerText('second');

    expect(useRewindComposerStore.getState().pendingText).toBe('second');
  });
});

describe('RewindComposerBridge', () => {
  it('renders nothing and touches the composer only when text is pending', () => {
    const { container } = render(<RewindComposerBridge />);

    expect(container).toBeEmptyDOMElement();
    expect(setText).not.toHaveBeenCalled();
  });

  it('drains a pending prompt into the composer, ONCE', () => {
    const { rerender } = render(<RewindComposerBridge />);

    useRewindComposerStore.getState().requestComposerText('my original prompt');
    rerender(<RewindComposerBridge />);

    expect(setText).toHaveBeenCalledWith('my original prompt');
    expect(useRewindComposerStore.getState().pendingText).toBeNull();

    // A later re-render must not re-apply the consumed text over whatever the
    // user has since typed.
    rerender(<RewindComposerBridge />);
    expect(setText).toHaveBeenCalledTimes(1);
  });
});
