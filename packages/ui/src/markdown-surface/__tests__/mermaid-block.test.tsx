import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderMock = vi.hoisted(() => vi.fn());
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

import { MermaidBlock } from '../mermaid-block';

describe('MermaidBlock', () => {
  beforeEach(() => {
    renderMock.mockReset();
  });

  it('renders the diagram svg on success', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-diagram="ok"></svg>' });
    render(<MermaidBlock code="graph TD; a-->b;" />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram').innerHTML).toContain('data-diagram="ok"');
    });
  });

  it('shows the error AND the fenced source on parse failure', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'));
    render(<MermaidBlock code="graph TD; a-->" />);
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-error')).toHaveTextContent('Parse error on line 1');
    });
    expect(screen.getByText('graph TD; a-->')).toBeInTheDocument();
  });

  it('shows a loading state before render resolves', () => {
    renderMock.mockReturnValue(new Promise(() => undefined));
    render(<MermaidBlock code="graph TD; a-->b;" />);
    expect(screen.getByText(/rendering diagram/i)).toBeInTheDocument();
  });
});
