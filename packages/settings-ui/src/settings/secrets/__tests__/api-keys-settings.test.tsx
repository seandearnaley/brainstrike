import type { DeprecatedEnvVarReport, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysSettings } from '../api-keys-settings';
import type { CredentialInventoryProps } from '../credential-inventory/credential-inventory';
import type { EnvironmentSectionProps } from '../environment/environment-section';

const { environmentPropsSpy, inventoryPropsSpy } = vi.hoisted(() => ({
  environmentPropsSpy: vi.fn(),
  inventoryPropsSpy: vi.fn(),
}));

vi.mock('../credential-inventory/credential-inventory', () => ({
  CredentialInventory: (props: CredentialInventoryProps) => {
    inventoryPropsSpy(props);
    return <div data-testid="credential-inventory" />;
  },
}));

vi.mock('../environment/environment-section', () => ({
  EnvironmentSection: (props: EnvironmentSectionProps) => {
    environmentPropsSpy(props);
    return (
      <div data-testid="environment-section">
        <button
          data-testid="environment-select-openai"
          onClick={() => props.onSelectCredentialSlot?.('openai')}
          type="button"
        >
          select openai
        </button>
      </div>
    );
  },
}));

vi.mock('@brainstrike/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode; className?: string }) => (
    <div>{children}</div>
  ),
}));

describe('ApiKeysSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Credential Inventory as the whole API-keys surface (no dropdown cards)', () => {
    render(<ApiKeysSettings />);

    expect(screen.getByTestId('credential-inventory')).toBeDefined();
    expect(screen.getByText('Credential Inventory')).toBeDefined();
  });

  it('forwards status error, provider key sources, and deprecated env vars', () => {
    const statusProviderKeySources: readonly ProviderKeySource<SupportedProvider>[] = [
      { envVar: 'OPENAI_API_KEY', provider: 'openai' as SupportedProvider, source: 'env' },
    ];
    const statusDeprecatedEnvVars: readonly DeprecatedEnvVarReport[] = [
      {
        envVar: 'OPENAI_API_KEY_V2',
        provider: 'openai' as SupportedProvider,
        replacement: 'OPENAI_API_KEY',
      },
    ];

    render(
      <ApiKeysSettings
        statusDeprecatedEnvVars={statusDeprecatedEnvVars}
        statusError="The user-data environment file is malformed."
        statusProviderKeySources={statusProviderKeySources}
      />
    );

    expect(inventoryPropsSpy).toHaveBeenCalledWith({
      deprecatedEnvVars: statusDeprecatedEnvVars,
      highlightedSlotId: undefined,
      highlightNonce: 0,
      statusError: 'The user-data environment file is malformed.',
      statusProviderKeySources,
    });
  });

  it('forwards the SAME deprecation reports to the Environment section as to the rows', () => {
    const statusDeprecatedEnvVars: readonly DeprecatedEnvVarReport[] = [
      {
        envVar: 'AI_OPENAI_API_KEY',
        provider: 'openai' as SupportedProvider,
        replacement: 'OPENAI_API_KEY',
      },
    ];

    render(<ApiKeysSettings statusDeprecatedEnvVars={statusDeprecatedEnvVars} />);

    // One derivation feeding both surfaces — the rename target can never
    // disagree between the row and the Environment section.
    expect(inventoryPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deprecatedEnvVars: statusDeprecatedEnvVars })
    );
    expect(environmentPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deprecatedEnvVars: statusDeprecatedEnvVars })
    );
  });

  it('renders the Environment section beneath the Credential Inventory', () => {
    render(<ApiKeysSettings />);

    const inventory = screen.getByTestId('credential-inventory');
    const environment = screen.getByTestId('environment-section');

    expect(
      inventory.compareDocumentPosition(environment) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('forwards the injected reveal capability to the Environment section', () => {
    const onRevealPath = vi.fn();

    render(<ApiKeysSettings onRevealPath={onRevealPath} />);

    expect(environmentPropsSpy).toHaveBeenCalledWith(expect.objectContaining({ onRevealPath }));
  });

  it('highlights the inventory row a chosen environment chip points at', async () => {
    render(<ApiKeysSettings />);
    inventoryPropsSpy.mockClear();

    fireEvent.click(screen.getByTestId('environment-select-openai'));

    await waitFor(() => {
      expect(inventoryPropsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ highlightedSlotId: 'openai' })
      );
    });
  });

  it('re-triggers the highlight when the SAME chip is clicked again', async () => {
    render(<ApiKeysSettings />);

    fireEvent.click(screen.getByTestId('environment-select-openai'));
    await waitFor(() => {
      expect(inventoryPropsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ highlightedSlotId: 'openai', highlightNonce: 1 })
      );
    });

    // Same slot id: without a nonce the props would be identical and the row
    // would never re-scroll, so a second click would appear to do nothing.
    fireEvent.click(screen.getByTestId('environment-select-openai'));
    await waitFor(() => {
      expect(inventoryPropsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ highlightedSlotId: 'openai', highlightNonce: 2 })
      );
    });
  });

  it('clears the highlight after it has served its purpose', async () => {
    vi.useFakeTimers();
    try {
      render(<ApiKeysSettings />);
      fireEvent.click(screen.getByTestId('environment-select-openai'));

      await vi.waitFor(() => {
        expect(inventoryPropsSpy).toHaveBeenCalledWith(
          expect.objectContaining({ highlightedSlotId: 'openai' })
        );
      });

      inventoryPropsSpy.mockClear();
      // Wrapped in act so React flushes the expiry re-render before asserting.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(inventoryPropsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ highlightedSlotId: undefined })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
