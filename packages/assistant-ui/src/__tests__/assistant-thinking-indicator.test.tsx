// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrainstrikeThinkingMark } from '../assistant-thinking-indicator';

describe('BrainstrikeThinkingMark', () => {
  it('applies the static class and data-live="false" when live is false', () => {
    render(<BrainstrikeThinkingMark live={false} />);
    const mark = screen.getByTestId('assistant-thinking-mark');
    expect(mark).toHaveClass('bs-thinking-mark-static');
    expect(mark).toHaveAttribute('data-live', 'false');
  });

  it('omits the static class and reports data-live="true" by default', () => {
    render(<BrainstrikeThinkingMark />);
    const mark = screen.getByTestId('assistant-thinking-mark');
    expect(mark).not.toHaveClass('bs-thinking-mark-static');
    expect(mark).toHaveAttribute('data-live', 'true');
  });
});
