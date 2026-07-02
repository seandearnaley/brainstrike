import { useBrainstrikeSchemaReadyCapability } from '@brainstrike/db';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbSchemaVerifier } from '../components/db-schema-verifier';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '../stores/vector-status-ui-store';

vi.mock('@brainstrike/db', () => ({
  useBrainstrikeSchemaReadyCapability: vi.fn(),
}));

const mockUseBrainstrikeSchemaReadyCapability = vi.mocked(useBrainstrikeSchemaReadyCapability);

describe('DbSchemaVerifier', () => {
  beforeEach(() => {
    __resetVectorStatusUIStoreForTests();
    mockUseBrainstrikeSchemaReadyCapability.mockReset();
    mockUseBrainstrikeSchemaReadyCapability.mockReturnValue(false);
  });

  it('marks schema verified from the runtime schema-ready capability', async () => {
    mockUseBrainstrikeSchemaReadyCapability.mockReturnValue(true);

    render(
      <DbSchemaVerifier>
        <div>app</div>
      </DbSchemaVerifier>
    );

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().schemaVerified).toBe(true);
    });
  });

  it('clears schema verification when the runtime schema-ready capability is absent', async () => {
    mockUseBrainstrikeSchemaReadyCapability.mockReturnValue(true);

    const { rerender } = render(
      <DbSchemaVerifier>
        <div>app</div>
      </DbSchemaVerifier>
    );

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().schemaVerified).toBe(true);
    });

    mockUseBrainstrikeSchemaReadyCapability.mockReturnValue(false);

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
