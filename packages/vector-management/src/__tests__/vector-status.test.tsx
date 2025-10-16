import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorStatus } from '../vector-status';

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<object>('@brainstrike/ui');
  return {
    ...actual,
    Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
    CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Label: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    useToast: () => ({ toast: vi.fn() }),
  };
});

vi.mock('@brainstrike/embeddings', () => ({
  TransformersBackend: { getBestDevice: () => 'cpu' },
  SimpleEmbeddingService: {
    listModels: () => ['model1', 'model2'],
    getDefaultModelKey: () => 'model1',
  },
}));

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<object>('@brainstrike/db');
  return {
    ...(actual as object),
    useVectorEnabled: () => false,
    usePGliteDatabase: () => null,
  };
});

describe('VectorStatus', () => {
  beforeEach(() => {
    process.env = { ...(process.env || {}), EMBED_QUEUE_ENABLED: 'false' };
  });

  it('renders disabled worker and pgvector off when queue disabled', () => {
    render(<VectorStatus />);
    expect(screen.getByText('Vector Status')).toBeInTheDocument();
    expect(screen.getByText(/pgvector: off/i)).toBeInTheDocument();
    expect(screen.getByText(/worker: disabled/i)).toBeInTheDocument();
  });
});
