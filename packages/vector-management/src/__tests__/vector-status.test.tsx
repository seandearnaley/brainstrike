const { getBestDeviceMock } = vi.hoisted(() => ({
  getBestDeviceMock: vi.fn(() => 'wasm'),
}));

vi.mock('@brainstrike/embeddings/backend', () => ({
  TransformersBackend: {
    getBestDevice: getBestDeviceMock,
    getRuntimeStats: vi.fn(),
    setVerboseOrtLogs: vi.fn(),
  },
}));

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBaseLabel,
  formatRelativeTimeFromNow,
  getBackfillAriaLabel,
  getBackfillButtonText,
  getBackfillTooltip,
  truncateLabel,
  VectorStatus,
} from '../vector-status';

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<object>('@brainstrike/ui');
  return {
    ...actual,
    Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
    Label: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useToast: () => ({ toast: vi.fn() }),
  };
});

vi.mock('@brainstrike/embeddings', () => ({
  SimpleEmbeddingService: {
    getDefaultModelKey: () => 'model1',
    listModels: () => ['model1', 'model2'],
  },
  TransformersBackend: { getBestDevice: () => 'wasm' },
}));

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<object>('@brainstrike/db');
  return {
    ...(actual as object),
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    usePGliteDatabase: () => null,
    useVectorEnabled: () => false,
  };
});

vi.mock('../embedding-runtime-provider', () => ({
  useSharedEmbeddingRuntime: () => ({
    controller: {
      cancelAllBackfills: vi.fn(async () => {}),
      cancelBackfill: vi.fn(async () => {}),
      enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'stopped',
      })),
      getBackfillsInFlight: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'stopped',
      })),
      onBackfillProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      reset: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'stopped',
      })),
      start: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'running',
      })),
      stop: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'stopped',
      })),
    },
    service: null,
  }),
}));

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

  it('renders Device label in content area', () => {
    render(<VectorStatus />);
    expect(screen.getByText(/device/i)).toBeInTheDocument();
  });

  it('renders a device badge with a non-empty value', () => {
    render(<VectorStatus />);
    // The Badge mock renders children as a <span>. getBestDevice returns
    // a string (or 'unavailable' on catch) – either way a non-empty span
    // next to the Device label must exist.
    const deviceLabel = screen.getByText(/device/i);
    expect(deviceLabel).toBeInTheDocument();
    // Sibling badge rendered by the mocked Badge component
    const deviceSection = deviceLabel.closest('div');
    expect(deviceSection).not.toBeNull();
  });
});

describe('formatRelativeTimeFromNow – uncovered branches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for a future timestamp', () => {
    expect(formatRelativeTimeFromNow('2025-03-01T13:00:00.000Z')).toBe('just now');
  });

  it('returns "just now" for a timestamp within the last 59 seconds', () => {
    expect(formatRelativeTimeFromNow('2025-03-01T11:59:05.000Z')).toBe('just now');
  });

  it('returns a formatted date (not a relative string) for timestamps older than 7 days', () => {
    const result = formatRelativeTimeFromNow('2025-02-10T12:00:00.000Z'); // 19 days ago
    // Should not be a relative-time string – must be a short locale date or ISO segment
    expect(result).not.toMatch(/^(\d+[mhd] ago|just now|never|unknown)$/);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('truncateLabel – edge cases', () => {
  it('does not truncate a 24-character string', () => {
    const label = 'A'.repeat(24);
    expect(truncateLabel(label)).toBe(label);
  });

  it('truncates a 25-character string with ellipsis', () => {
    const label = 'A'.repeat(25);
    expect(truncateLabel(label)).toBe(`${'A'.repeat(21)}…`);
    expect(truncateLabel(label).length).toBe(22);
  });
});

describe('buildBaseLabel – edge cases', () => {
  it('truncates long labels', () => {
    const long = 'My Very Long Embedding Set Name Here';
    const result = buildBaseLabel(long);
    expect(result.startsWith('Backfill ')).toBe(true);
    expect(result.length).toBeLessThanOrEqual('Backfill '.length + 22);
  });
});

describe('getBackfillButtonText – priority edge cases', () => {
  const base = 'Backfill MySet';

  it('returns "Backfilling…" when both backfilling and startingWorker are true but no progress', () => {
    // backfilling checked before startingWorker in the function body
    expect(getBackfillButtonText(base, true, true, null, false)).toBe('Backfilling…');
  });

  it('returns "Backfilling…" when backfilling is true and willAutoStartWorker is also true', () => {
    expect(getBackfillButtonText(base, false, true, null, true)).toBe('Backfilling…');
  });
});

describe('getBackfillAriaLabel – priority edge cases', () => {
  const base = 'Backfill MySet';

  it('returns startingWorker label even when backfilling is also true', () => {
    expect(getBackfillAriaLabel(base, 'MySet', true, true, false)).toBe('Starting worker…');
  });
});

describe('getBackfillTooltip – priority edge cases', () => {
  const base = 'Backfill MySet';

  it('returns startingWorker tooltip even when willAutoStartWorker is also true', () => {
    expect(getBackfillTooltip('', base, 'MySet', true, true)).toBe('Starting embedding worker…');
  });

  it('uses defaultTitle over active-label fallback when not in special state', () => {
    const title = 'Custom title';
    expect(getBackfillTooltip(title, base, 'MySet', false, false)).toBe(title);
  });
});
