import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MermaidBlock } from '../mermaid-block';

describe('MermaidBlock', () => {
  it('draws the diagram as svg', async () => {
    render(<MermaidBlock code={'flowchart LR\n  A[Draft] --> B[Published]'} />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).not.toBeNull();
    });
    expect(screen.getByTestId('mermaid-diagram')).toHaveTextContent('Published');
  });

  it('shows why a malformed diagram cannot be drawn, with the offending line', async () => {
    render(<MermaidBlock code="graph TD; a-->" />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram')).toHaveTextContent('Parse error on line 1');
    });
    const host = screen.getByTestId('mermaid-diagram');
    expect(host.querySelector('svg')).toBeNull();
    expect(host.textContent).toContain('graph TD; a-->');
  });
});
