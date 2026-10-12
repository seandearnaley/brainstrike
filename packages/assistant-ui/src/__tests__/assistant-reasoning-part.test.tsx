import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useMessagePartReasoningMock = vi.hoisted(() => vi.fn());

vi.mock('@assistant-ui/react', () => ({
  useMessagePartReasoning: useMessagePartReasoningMock,
}));

import { AssistantReasoningPart } from '../assistant-reasoning-part';

describe('AssistantReasoningPart', () => {
  it('strips provider citation markers from reasoning text', () => {
    // Reasoning renders raw, bypassing the markdown primitive's `preprocess`,
    // so it needs the strip applied directly — otherwise this is the one
    // visible model-authored surface where a marker would still leak.
    useMessagePartReasoningMock.mockReturnValue({
      text: 'Checking the release notes.\u{E200}cite\u{E202}turn0search0\u{E201}',
    });

    render(<AssistantReasoningPart />);

    expect(screen.getByTestId('local-reasoning-part')).toHaveTextContent(
      'Checking the release notes.'
    );
    expect(screen.getByTestId('local-reasoning-part').textContent).not.toContain('turn0search0');
  });

  it('renders marker-free reasoning unchanged', () => {
    useMessagePartReasoningMock.mockReturnValue({ text: 'Plain reasoning text.' });

    render(<AssistantReasoningPart />);

    expect(screen.getByTestId('local-reasoning-part')).toHaveTextContent('Plain reasoning text.');
  });
});
