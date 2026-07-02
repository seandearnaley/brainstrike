import type { DbInitializationStatus, ProfileBootstrapReport } from '@brainstrike/db';
import {
  useBrainstrikeDbClient,
  useOptionalDbInitializationStatus,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbSchemaVerifier } from '../components/db-schema-verifier';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '../stores/vector-status-ui-store';

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    useBrainstrikeDbClient: vi.fn(),
    useOptionalDbInitializationStatus: vi.fn(),
    useOptionalProfileBootstrapReport: vi.fn(),
  };
});

const mockUseBrainstrikeDbClient = vi.mocked(useBrainstrikeDbClient);
const mockUseOptionalDbInitializationStatus = vi.mocked(useOptionalDbInitializationStatus);
const mockUseOptionalProfileBootstrapReport = vi.mocked(useOptionalProfileBootstrapReport);

const readyTursoReport: ProfileBootstrapReport = {
  checks: [],
  failure: null,
  phase: 'ready',
  profileId: 'test',
  ready: true,
  runtime: {
    engine: 'turso',
    host: 'electron-utility',
    persistence: 'filesystem',
  },
  search: {
    indexedSearch: 'available',
    message: 'Indexed search is owned by a split search index store.',
    ownershipMode: 'split-search-index-store',
  },
  startedAt: '2026-06-30T07:00:00.000Z',
  updatedAt: '2026-06-30T07:00:01.000Z',
};

describe('DbSchemaVerifier', () => {
  beforeEach(() => {
    __resetVectorStatusUIStoreForTests();
    mockUseBrainstrikeDbClient.mockReset();
    mockUseOptionalDbInitializationStatus.mockReset();
    mockUseOptionalProfileBootstrapReport.mockReset();
    mockUseBrainstrikeDbClient.mockReturnValue(null);
    mockUseOptionalDbInitializationStatus.mockReturnValue('idle' as DbInitializationStatus);
    mockUseOptionalProfileBootstrapReport.mockReturnValue(null);
  });

  it('marks schema verified from a ready Turso bootstrap report without exposing a PGlite client', async () => {
    mockUseOptionalDbInitializationStatus.mockReturnValue('ready' as DbInitializationStatus);
    mockUseOptionalProfileBootstrapReport.mockReturnValue(readyTursoReport);

    render(
      <DbSchemaVerifier>
        <div>app</div>
      </DbSchemaVerifier>
    );

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().schemaVerified).toBe(true);
    });
    expect(mockUseBrainstrikeDbClient).toHaveReturnedWith(null);
  });

  it('clears schema verification when Turso bootstrap is no longer ready', async () => {
    mockUseOptionalDbInitializationStatus.mockReturnValue('ready' as DbInitializationStatus);
    mockUseOptionalProfileBootstrapReport.mockReturnValue(readyTursoReport);

    const { rerender } = render(
      <DbSchemaVerifier>
        <div>app</div>
      </DbSchemaVerifier>
    );

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().schemaVerified).toBe(true);
    });

    mockUseOptionalDbInitializationStatus.mockReturnValue('idle' as DbInitializationStatus);
    mockUseOptionalProfileBootstrapReport.mockReturnValue(null);

    rerender(
      <DbSchemaVerifier>
        <div>app</div>
      </DbSchemaVerifier>
    );

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().schemaVerified).toBe(false);
    });
  });
});
