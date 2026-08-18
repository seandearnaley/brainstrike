import type { DeprecatedEnvVarReport, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysSettings } from '../api-keys-settings';
import type { CredentialInventoryProps } from '../credential-inventory/credential-inventory';

const { inventoryPropsSpy } = vi.hoisted(() => ({
  inventoryPropsSpy: vi.fn(),
}));

vi.mock('../credential-inventory/credential-inventory', () => ({
  CredentialInventory: (props: CredentialInventoryProps) => {
    inventoryPropsSpy(props);
    return <div data-testid="credential-inventory" />;
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
      statusError: 'The user-data environment file is malformed.',
      statusProviderKeySources,
    });
  });
});
