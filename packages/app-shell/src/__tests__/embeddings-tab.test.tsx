import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingsTab } from '../embeddings-tab';

vi.mock('../embeddings-panel', () => ({
  EmbeddingsPanel: () => <div>Embeddings Panel Content</div>,
}));

describe('EmbeddingsTab', () => {
  it('renders embeddings panel', () => {
    render(<EmbeddingsTab />);

    expect(screen.getByText('Embeddings Panel Content')).toBeInTheDocument();
  });
});
