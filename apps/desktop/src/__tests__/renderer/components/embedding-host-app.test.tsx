// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingHostApp } from '../../../renderer/components/embedding-host-app';

vi.mock('../../../renderer/components/background-host-error-boundary', () => ({
  BackgroundHostErrorBoundary: ({
    children,
    host,
  }: {
    children: React.ReactNode;
    host: string;
  }) => (
    <div data-host={host} data-testid="host-boundary">
      {children}
    </div>
  ),
}));

vi.mock('../../../renderer/components/embedding-host-runtime', () => ({
  EmbeddingHostRuntime: () => <div>Embedding host runtime</div>,
}));

describe('EmbeddingHostApp', () => {
  it('renders the embedding host runtime inside its error boundary', () => {
    render(<EmbeddingHostApp />);

    expect(screen.getByTestId('host-boundary')).toHaveAttribute('data-host', 'embedding-host');
    expect(screen.getByText('Embedding host runtime')).toBeInTheDocument();
  });
});
