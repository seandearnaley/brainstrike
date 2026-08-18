import { __resetSecretsStoreForTests } from '@brainstrike/app-state/stores/secrets-store';
import type { ProviderCredential, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { ProviderAuthStatus } from '@brainstrike/assistant-contract/provider-auth';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialInventory } from '../credential-inventory/credential-inventory';
import { OAUTH_PERSONAL_USE_NOTICE } from '../credential-inventory/credential-oauth-notice';

const { listProvidersMock, providerVendorEnvKeyMock, toastMock } = vi.hoisted(() => ({
  listProvidersMock: vi.fn(),
  providerVendorEnvKeyMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@brainstrike/assistant-contract/provider-metadata', () => ({
  listProviders: listProvidersMock,
  providerAuthType: (provider: string) =>
    (listProvidersMock() as { authType: string; id: string }[]).find(
      (definition) => definition.id === provider
    )?.authType ?? 'api_key',
  // The subscription provider declares NO env keys at all (legal gate
  // constraint 4) — that absence is what the slot builder must tolerate.
  providerEnvKeys: () => [],
  providerVendorEnvKey: providerVendorEnvKeyMock,
}));

vi.mock('@brainstrike/ui', () => ({
  Badge: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <span data-testid={testId}>{children}</span>,
  Button: ({
    children,
    disabled,
    onClick,
    ref,
    'data-testid': testId,
    variant: _variant,
    size: _size,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    ref?: React.Ref<HTMLButtonElement>;
    'data-testid'?: string;
    variant?: string;
    size?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} ref={ref} type="button">
      {children}
    </button>
  ),
  CopyTextButton: ({
    ariaLabel,
    label,
    text,
  }: {
    ariaLabel: string;
    label?: string;
    text: string | (() => string);
  }) => (
    <button
      aria-label={ariaLabel}
      data-copy-text={typeof text === 'function' ? text() : text}
      type="button"
    >
      {label ?? 'Copy'}
    </button>
  ),
  getProviderColor: () => 'hsl(0, 0%, 50%)',
  Input: (props: Record<string, unknown>) => <input {...props} />,
  ProviderIcon: ({ providerId }: { providerId: string }) => (
    <span data-testid={`provider-icon-${providerId}`} />
  ),
  Table: ({ children, ...rest }: { children: React.ReactNode }) => (
    <table {...rest}>{children}</table>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children, colSpan }: { children?: React.ReactNode; colSpan?: number }) => (
    <td colSpan={colSpan}>{children}</td>
  ),
  TableHead: ({ children }: { children?: React.ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <tr data-testid={testId}>{children}</tr>,
  TooltipIconButton: ({
    children,
    tooltip,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    tooltip: string;
    'data-testid'?: string;
  }) => (
    <button aria-label={tooltip} data-testid={testId} type="button">
      {children}
    </button>
  ),
  useToast: () => ({ toast: toastMock }),
}));

const SLOT_ID = 'openai-codex';

const CODEX_DEFINITION = {
  authType: 'oauth_subscription',
  displayName: 'OpenAI (ChatGPT)',
  docsUrl: 'https://developers.openai.com/codex/auth',
  id: SLOT_ID,
  keyNotes:
    'Sign in with your own ChatGPT Plus or Pro account. Usage draws on your personal subscription quota; commercial or multi-user serving requires platform API keys instead.',
};

interface SecretsApi {
  clearAll: () => Promise<{ success: boolean }>;
  deleteKey: (provider: string) => Promise<boolean>;
  getKey: (provider: string) => Promise<string | null>;
  list: () => Promise<ProviderKeySource<SupportedProvider | 'tavily'>[]>;
  listStored: () => Promise<string[]>;
  saveCredential: (
    provider: string,
    credential: ProviderCredential
  ) => Promise<true | { error: string; ok: false }>;
  saveKey: (provider: string, value: string) => Promise<true>;
}

const setWindowValue = (key: string, value: unknown): void => {
  Object.defineProperty(window, key, { configurable: true, value, writable: true });
};

const createSecretsApi = (): SecretsApi => ({
  clearAll: vi.fn().mockResolvedValue({ success: true }),
  deleteKey: vi.fn().mockResolvedValue(true),
  getKey: vi.fn().mockResolvedValue(null),
  list: vi.fn().mockResolvedValue([]),
  listStored: vi.fn().mockResolvedValue([]),
  saveCredential: vi.fn().mockResolvedValue(true),
  saveKey: vi.fn().mockResolvedValue(true),
});

/**
 * A faithful stand-in for the desktop engine: `start` resolves at the FIRST
 * transition and leaves that value as the state a later `status()` reports —
 * exactly the contract the row's post-action refresh depends on.
 */
const createProviderAuth = (
  initial: ProviderAuthStatus,
  transitions: Partial<Record<'cancel' | 'disconnect' | 'start', ProviderAuthStatus>> = {}
) => {
  let current = initial;
  const apply = (next: ProviderAuthStatus | undefined): ProviderAuthStatus => {
    if (next) {
      current = next;
    }
    return current;
  };
  return {
    cancel: vi.fn(async () => apply(transitions.cancel ?? { state: 'disconnected' })),
    disconnect: vi.fn(async () => apply(transitions.disconnect ?? { state: 'disconnected' })),
    start: vi.fn(async (_provider: string, _method?: string) => apply(transitions.start)),
    status: vi.fn(async () => current),
  };
};

const renderCodexRow = async (
  auth: ReturnType<typeof createProviderAuth> | undefined
): Promise<void> => {
  if (auth) {
    setWindowValue('providerAuth', auth);
  }
  render(<CredentialInventory providers={[SLOT_ID]} />);
  await waitFor(() => {
    expect(screen.getByTestId(`credential-row-${SLOT_ID}`)).toBeTruthy();
  });
};

/**
 * The `oauth_subscription` slot treatment (BST-1356): a sign-in flow instead
 * of a secret field, capability-gated on the desktop `window.providerAuth`
 * bridge. The harness is duplicated from the aws suite deliberately so each
 * file stays independently readable.
 */
describe('CredentialInventory oauth_subscription slot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSecretsStoreForTests();
    listProvidersMock.mockReturnValue([CODEX_DEFINITION]);
    providerVendorEnvKeyMock.mockReturnValue(undefined);
    setWindowValue('secrets', createSecretsApi());
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup requires property removal
    delete (window as unknown as Record<string, unknown>)['secrets'];
    // biome-ignore lint/performance/noDelete: test cleanup requires property removal
    delete (window as unknown as Record<string, unknown>)['providerAuth'];
  });

  it('renders a row for the subscription provider even though it declares no env key', async () => {
    await renderCodexRow(createProviderAuth({ state: 'disconnected' }));

    // The Variable column says there is no variable rather than sitting empty.
    expect(screen.queryByTestId(`credential-env-var-${SLOT_ID}`)).toBeNull();
    expect(screen.getByTestId(`credential-no-env-var-${SLOT_ID}`).textContent).toContain(
      'no environment variable'
    );
    expect(await screen.findByTestId(`credential-oauth-connect-${SLOT_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`credential-oauth-device-${SLOT_ID}`)).toBeTruthy();
  });

  it('Connect starts the loopback flow with NO method argument', async () => {
    const auth = createProviderAuth({ state: 'disconnected' }, { start: { state: 'connecting' } });
    await renderCodexRow(auth);

    fireEvent.click(await screen.findByTestId(`credential-oauth-connect-${SLOT_ID}`));

    await waitFor(() => {
      expect(auth.start).toHaveBeenCalledWith(SLOT_ID);
    });
  });

  it('the secondary button starts the DEVICE flow explicitly', async () => {
    const auth = createProviderAuth(
      { state: 'disconnected' },
      {
        start: {
          state: 'awaiting_device_code',
          userCode: 'WXYZ-1234',
          verificationUri: 'https://auth.openai.com/device',
        },
      }
    );
    await renderCodexRow(auth);

    fireEvent.click(await screen.findByTestId(`credential-oauth-device-${SLOT_ID}`));

    await waitFor(() => {
      expect(auth.start).toHaveBeenCalledWith(SLOT_ID, 'device');
    });
  });

  it('shows a waiting state with Cancel while the browser flow is open', async () => {
    const auth = createProviderAuth({ state: 'awaiting_browser' });
    await renderCodexRow(auth);

    expect(await screen.findByTestId(`credential-oauth-waiting-${SLOT_ID}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`credential-oauth-cancel-${SLOT_ID}`));

    await waitFor(() => {
      expect(auth.cancel).toHaveBeenCalledWith(SLOT_ID);
    });
  });

  it('renders the device code, its verification link, and a copy affordance', async () => {
    await renderCodexRow(
      createProviderAuth({
        state: 'awaiting_device_code',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://auth.openai.com/device',
      })
    );

    expect((await screen.findByTestId(`credential-oauth-user-code-${SLOT_ID}`)).textContent).toBe(
      'WXYZ-1234'
    );
    const link = screen.getByTestId(`credential-oauth-verification-uri-${SLOT_ID}`);
    expect(link.getAttribute('href')).toBe('https://auth.openai.com/device');
    // The copy affordance carries the CODE, not the URL.
    const copy = screen
      .getByTestId(`credential-oauth-copy-code-${SLOT_ID}`)
      .querySelector('button');
    expect(copy?.getAttribute('data-copy-text')).toBe('WXYZ-1234');
  });

  it('names the connected account and offers Disconnect', async () => {
    const auth = createProviderAuth({ accountId: 'user@example.com', state: 'connected' });
    await renderCodexRow(auth);

    expect((await screen.findByTestId(`credential-oauth-account-${SLOT_ID}`)).textContent).toBe(
      'user@example.com'
    );
    fireEvent.click(screen.getByTestId(`credential-oauth-disconnect-${SLOT_ID}`));

    await waitFor(() => {
      expect(auth.disconnect).toHaveBeenCalledWith(SLOT_ID);
    });
    expect(await screen.findByTestId(`credential-oauth-connect-${SLOT_ID}`)).toBeTruthy();
  });

  it('offers Reconnect with visible session-expired text', async () => {
    const auth = createProviderAuth({ state: 'reconnect_required' });
    await renderCodexRow(auth);

    expect(
      (await screen.findByTestId(`credential-oauth-session-expired-${SLOT_ID}`)).textContent
    ).toContain('Session expired');
    fireEvent.click(screen.getByTestId(`credential-oauth-reconnect-${SLOT_ID}`));

    await waitFor(() => {
      expect(auth.start).toHaveBeenCalledWith(SLOT_ID);
    });
  });

  it('LEGAL: states the personal-use terms before any connect action', async () => {
    await renderCodexRow(createProviderAuth({ state: 'disconnected' }));

    const notice = screen.getByTestId(`credential-oauth-personal-use-${SLOT_ID}`);
    // Verbatim against the exported constant — one rename target, and a
    // reword cannot slip through unnoticed (OAuth legal gate, constraint 4).
    expect(notice.textContent).toBe(OAUTH_PERSONAL_USE_NOTICE);
    expect(notice.textContent).toContain('your own ChatGPT subscription for personal use');
    expect(notice.textContent).toContain(
      'Commercial or multi-user serving requires platform API keys'
    );
  });

  it('offers NO key-management affordances at all', async () => {
    await renderCodexRow(createProviderAuth({ state: 'disconnected' }));
    await screen.findByTestId(`credential-oauth-connect-${SLOT_ID}`);

    for (const affordance of ['set', 'replace', 'remove', 'key-input', 'save', 'editor']) {
      expect(screen.queryByTestId(`credential-${affordance}-${SLOT_ID}`)).toBeNull();
    }
    expect(screen.queryByTestId(`credential-editor-row-${SLOT_ID}`)).toBeNull();
    expect(screen.queryAllByTestId(/^credential-(set|replace|remove|key-input)-/)).toHaveLength(0);
  });

  it('offers no connect affordance when the desktop bridge is absent (web)', async () => {
    await renderCodexRow(undefined);

    expect(screen.getByTestId(`credential-oauth-unavailable-${SLOT_ID}`).textContent).toContain(
      'desktop app'
    );
    expect(screen.queryByTestId(`credential-oauth-connect-${SLOT_ID}`)).toBeNull();
    expect(screen.queryByTestId(`credential-oauth-device-${SLOT_ID}`)).toBeNull();
    // The terms still render — the row explains what the provider IS.
    expect(screen.getByTestId(`credential-oauth-personal-use-${SLOT_ID}`)).toBeTruthy();
  });

  it('treats a PARTIAL providerAuth surface as no bridge at all', async () => {
    // A preload missing a method cannot drive the flow; pretending otherwise
    // would render buttons that reject at click time.
    setWindowValue('providerAuth', { start: vi.fn(), status: vi.fn() });
    render(<CredentialInventory providers={[SLOT_ID]} />);

    await waitFor(() => {
      expect(screen.getByTestId(`credential-oauth-unavailable-${SLOT_ID}`)).toBeTruthy();
    });
    expect(screen.queryByTestId(`credential-oauth-connect-${SLOT_ID}`)).toBeNull();
  });
});
