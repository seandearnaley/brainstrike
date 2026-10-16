/**
 * The desktop diagnostics snapshot no longer carries an `llmHost` field: the
 * local chat engine and its renderer host were retired, and the only hidden
 * runtime host left is the embedding host.
 *
 * This suite pins the CONSUMER against that producer shape. The snapshot type
 * is declared twice — once in `apps/desktop/src/desktop-platform-diagnostics.ts`
 * and once inside the panel — with no import across the bridge, so the compiler
 * cannot catch a field the producer stopped sending. The fixtures below are the
 * producer's real shape, which is the only thing that can.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemDiagnosticsPanel } from '../diagnostics/system-diagnostics-panel';

vi.mock('@brainstrike/vector-management', () => ({
  QueueDiagnosticsPanel: () => <div>Queue Diagnostics Mock</div>,
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

/** The snapshot `collectDesktopPlatformDiagnostics` returns today: no `llmHost`. */
function installRetiredHostSnapshot(): void {
  (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = {
    getSnapshot: vi.fn(async () => ({
      ok: true,
      value: {
        collectedAt: '2026-10-15T00:00:00.000Z',
        embeddingHost: {
          active: true,
          lastError: null,
          pendingRequestCount: 3,
          runtimeId: 'embedding-host:active',
          runtimeKind: 'embedding-host',
          sourceState: 'running',
          state: 'active',
        },
        indexing: { databaseWork: {} },
        reset: { status: 'idle', userDataPath: '/tmp/brainstrike-user-data' },
        telemetry: { backgroundRuntimeMetrics: [] },
      },
    })),
  };
  (window as Window & { embeddingHost?: unknown }).embeddingHost = {
    onStatus: vi.fn(() => () => undefined),
  };
}

describe('SystemDiagnosticsPanel desktop platform card after the LLM host retirement', () => {
  beforeEach(() => {
    installRetiredHostSnapshot();
  });

  afterEach(() => {
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
    (window as Window & { embeddingHost?: unknown }).embeddingHost = undefined;
  });

  it('renders the card from a snapshot with no llmHost field', async () => {
    render(<SystemDiagnosticsPanel />);

    expect(await screen.findByText('Desktop Platform')).toBeInTheDocument();
    expect(screen.getByText('Embedding Host')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('offers no LLM host row to read', async () => {
    render(<SystemDiagnosticsPanel />);

    expect(await screen.findByText('Desktop Platform')).toBeInTheDocument();
    expect(screen.queryByText('LLM Host')).not.toBeInTheDocument();
  });

  it('counts pending requests from the embedding host alone', async () => {
    render(<SystemDiagnosticsPanel />);

    expect(await screen.findByText('Pending Requests')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
