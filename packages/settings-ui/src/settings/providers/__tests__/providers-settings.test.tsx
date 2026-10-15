import '@testing-library/jest-dom/vitest';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import {
  __resetSecretsStoreForTests,
  useSecretsStore,
} from '@brainstrike/app-state/stores/secrets-store';
import type {
  ProviderVerificationSnapshot,
  ProviderVerificationStatus,
} from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvidersSettings } from '../providers-settings';

const { toggleModelMock } = vi.hoisted(() => ({ toggleModelMock: vi.fn() }));

vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: () => ({ query: vi.fn() }),
}));

vi.mock('@brainstrike/app-state/hooks/use-model-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/app-state/hooks/use-model-registry')>()),
  useEnsureModelRegistry: () => undefined,
}));

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  // Selector-aware, matching the real zustand store: both the page and
  // `useModelToggle` subscribe to one slice rather than the whole state.
  useModelRegistryStore: (selector?: (state: unknown) => unknown) => {
    const state = { models: currentModels, toggleModel: toggleModelMock };
    return selector ? selector(state) : state;
  },
}));

let currentModels: DbModel[] = [];

function model(overrides: Partial<DbModel> & Pick<DbModel, 'id' | 'providerId'>): DbModel {
  return {
    bestFor: null,
    capabilities: { streaming: true, type: 'llm' },
    description: null,
    icon: null,
    isEnabled: false,
    name: overrides.id,
    parameters: null,
    sortOrder: 0,
    tagline: null,
    ...overrides,
  };
}

interface SecretsApi {
  readonly list: () => Promise<unknown>;
}

function installSecretsBridge(list: () => Promise<unknown>): void {
  Object.defineProperty(window, 'secrets', {
    configurable: true,
    value: { list } satisfies SecretsApi,
    writable: true,
  });
}

/**
 * A controllable stand-in for app-shell's `verifyProviderCredential`. A plain
 * async FUNCTION, matching the real seam — a hook may not be passed as a value.
 */
function makeVerifier(status: ProviderVerificationStatus, detail?: string) {
  const verifyCalls: string[] = [];
  const verifyProvider = (providerId: string): Promise<ProviderVerificationSnapshot> => {
    verifyCalls.push(providerId);
    return Promise.resolve({
      freshness: 'live',
      result: {
        checkedAt: new Date().toISOString(),
        ...(detail === undefined ? {} : { detail }),
        status,
      },
    });
  };
  return { verifyCalls, verifyProvider };
}

/** Never settles: the probe is button-driven, so an idle card never calls it. */
const idleVerifier = (): Promise<ProviderVerificationSnapshot> =>
  new Promise<ProviderVerificationSnapshot>(() => undefined);

beforeAll(() => {
  if (typeof global.ResizeObserver === 'undefined') {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    global.ResizeObserver = ResizeObserver as unknown as typeof global.ResizeObserver;
  }
  // jsdom implements no layout, so the cross-link scroll is a no-op here.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  __resetSecretsStoreForTests();
  currentModels = [];
  toggleModelMock.mockReset();
  toggleModelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  (window as unknown as Record<string, unknown>)['secrets'] = undefined;
  (window as Window & { llmHost?: unknown }).llmHost = undefined;
  vi.restoreAllMocks();
});

describe('ProvidersSettings — first run', () => {
  it('offers registry-priority recommendations when nothing is connected', async () => {
    installSecretsBridge(() => Promise.resolve([]));

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    const panel = await screen.findByTestId('provider-recommendations');
    expect(within(panel).getByTestId('provider-recommendation-openai')).toBeInTheDocument();
    expect(within(panel).getByTestId('provider-recommendation-anthropic')).toBeInTheDocument();
    expect(within(panel).getByTestId('provider-recommendation-google')).toBeInTheDocument();
  });

  it('jumps straight to a provider card from a recommendation', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId('provider-recommendation-openai'));

    expect(screen.getByTestId('provider-card-body-openai')).toBeInTheDocument();
    expect(screen.getByTestId('provider-card-toggle-openai')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('hides the first-run panel once any provider is connected', async () => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openai', source: 'stored' }]));

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'connected'
      )
    );
    expect(screen.queryByTestId('provider-recommendations')).not.toBeInTheDocument();
  });
});

describe('ProvidersSettings — card state', () => {
  it('groups providers by runtime in picker order', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    // A desktop host: the hidden llm-host is reachable, so the browser-runtime
    // group is offered alongside the rest.
    (window as Window & { llmHost?: unknown }).llmHost = { warmup: async () => undefined };

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await screen.findByTestId('provider-group-hosted');
    expect(screen.getByTestId('provider-group-gateway')).toBeInTheDocument();
    expect(screen.getByTestId('provider-group-local')).toBeInTheDocument();
    expect(screen.getByTestId('provider-group-browser')).toBeInTheDocument();
  });

  // No second engine exists for a browser-runtime provider, so a host that
  // cannot reach the llm-host must not advertise models it can never run.
  it('withholds the browser-runtime group without a desktop llm-host', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    (window as Window & { llmHost?: unknown }).llmHost = undefined;

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await screen.findByTestId('provider-group-hosted');
    expect(screen.queryByTestId('provider-group-browser')).not.toBeInTheDocument();
    expect(screen.getByTestId('provider-group-local')).toBeInTheDocument();
  });

  it('names the credential store on the card and reports keyless runtimes distinctly', async () => {
    installSecretsBridge(() =>
      Promise.resolve([{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }])
    );

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await waitFor(() =>
      expect(screen.getByTestId('provider-key-source-openai')).toHaveTextContent(
        'Env (OPENAI_API_KEY)'
      )
    );
    // A keyless local runtime has no credential to name and must not be
    // reported as "Not set".
    expect(screen.queryByTestId('provider-key-source-ollama')).not.toBeInTheDocument();
    expect(screen.getByTestId('provider-connection-ollama')).toHaveAttribute(
      'data-connection',
      'not-applicable'
    );
  });

  it('reports unknown rather than "not set" when the listing fails', async () => {
    installSecretsBridge(() => Promise.reject(new Error('keychain locked')));

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'unknown'
      )
    );
  });

  it('shows the model count and enabled count on a connected card', async () => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openai', source: 'stored' }]));
    currentModels = [
      model({ id: 'gpt-a', isEnabled: true, providerId: 'openai' }),
      model({ id: 'gpt-b', providerId: 'openai' }),
    ];

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await waitFor(() =>
      expect(screen.getByTestId('provider-card-models-openai')).toHaveTextContent(
        '2 models · 1 enabled'
      )
    );
  });

  it('surfaces registry guidance and the docs link, never hand-written provider copy', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId('provider-card-toggle-anthropic'));

    // The card surfaces the registry's docsUrl. `keyFormatHint`/`keyNotes` are
    // deliberately NOT repeated here — the composed credential editor renders
    // them at the point of entry, and duplicating them showed a provider's
    // notes twice on one screen.
    expect(screen.getByTestId('provider-docs-link-anthropic')).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys'
    );
    expect(screen.getByTestId('provider-guidance-anthropic')).not.toHaveTextContent('sk-ant-');

    // …and the hint IS reachable, from the editor the card composes.
    await user.click(await screen.findByTestId('credential-set-anthropic'));
    expect(await screen.findByTestId('credential-editor-hint-anthropic')).toHaveTextContent(
      'sk-ant-'
    );
  });

  it('renders only the expanded provider’s credential row', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));

    await waitFor(() => expect(screen.getByTestId('credential-row-openai')).toBeInTheDocument());
    expect(screen.queryByTestId('credential-row-anthropic')).not.toBeInTheDocument();
  });
});

describe('ProvidersSettings — subscription providers (BST-1356)', () => {
  // Exercised against the REAL registry entry, not a synthetic definition.
  const CODEX = 'openai-codex';

  it('never presents a subscription provider as a key to paste', async () => {
    installSecretsBridge(() => Promise.resolve([]));

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await screen.findByTestId(`provider-card-${CODEX}`);
    // Its state comes from sign-in, so the key listing being "ready and empty"
    // must not render it as an unset API key.
    expect(screen.getByTestId(`provider-key-source-${CODEX}`)).toHaveTextContent(
      /subscription sign-in|signed in/i
    );
    // …and the "add a key" shortlist must not offer it.
    expect(screen.queryByTestId(`provider-recommendation-${CODEX}`)).not.toBeInTheDocument();
  });

  it('renders the sign-in arm and its personal-use notice, not a credential editor', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId(`provider-card-toggle-${CODEX}`));

    // The composed row owns the oauth treatment (BST-1356), so the Hub gets it
    // without duplicating a single affordance.
    expect(await screen.findByTestId(`credential-oauth-personal-use-${CODEX}`)).toBeInTheDocument();
    // No key-management affordances exist for this auth type at all.
    expect(screen.queryByTestId(`credential-set-${CODEX}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`credential-key-input-${CODEX}`)).not.toBeInTheDocument();
    // jsdom has no `window.providerAuth`, which is exactly the web case: the
    // row says sign-in is desktop-only rather than offering a dead button.
    expect(screen.getByTestId(`credential-oauth-unavailable-${CODEX}`)).toBeInTheDocument();
    // …and the card must not offer "Get an API key" for an account you sign
    // into. Its row already links the same docs as "How sign-in works".
    expect(screen.queryByTestId(`provider-docs-link-${CODEX}`)).not.toBeInTheDocument();
  });

  it('keeps the personal-use notice on web, where there is no bridge at all', async () => {
    // No secrets bridge either — the real web wiring. The legal copy must
    // survive the read-only path rather than being replaced by the env note.
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId(`provider-card-toggle-${CODEX}`));

    expect(await screen.findByTestId(`credential-oauth-personal-use-${CODEX}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`provider-readonly-note-${CODEX}`)).not.toBeInTheDocument();
  });
});

describe('ProvidersSettings — test connection', () => {
  it.each<[ProviderVerificationStatus, string]>([
    ['verified', 'success'],
    ['verified_limited', 'warning'],
    ['invalid', 'danger'],
    ['unreachable', 'warning'],
  ])('renders %s with its own tone', async (status, tone) => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openai', source: 'stored' }]));
    const { verifyProvider } = makeVerifier(status);
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={verifyProvider} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));
    await user.click(screen.getByTestId('provider-test-connection-openai'));

    const result = await screen.findByTestId('provider-verification-openai');
    expect(result).toHaveAttribute('data-status', status);
    expect(result).toHaveAttribute('data-tone', tone);
    expect(result).toHaveTextContent(/checked/);
  });

  it('shows the advisory detail a probe returns', async () => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openrouter', source: 'stored' }]));
    const { verifyProvider } = makeVerifier('verified', 'HTTP 200 · 4.20 credits remaining');
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={verifyProvider} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openrouter'));
    await user.click(screen.getByTestId('provider-test-connection-openrouter'));

    expect(await screen.findByTestId('provider-verification-detail-openrouter')).toHaveTextContent(
      '4.20 credits remaining'
    );
  });

  it('disables the probe while the provider is not connected', async () => {
    installSecretsBridge(() => Promise.resolve([]));
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));
    await waitFor(() =>
      expect(screen.getByTestId('provider-test-connection-openai')).toBeDisabled()
    );
  });
});

describe('ProvidersSettings — connect → models chaining', () => {
  it('auto-verifies and opens the model list when a provider becomes connected', async () => {
    let sources: unknown[] = [];
    installSecretsBridge(() => Promise.resolve(sources));
    currentModels = [
      model({ id: 'gpt-5.2', name: 'GPT-5.2', providerId: 'openai' }),
      model({ id: 'gpt-mini', name: 'GPT Mini', providerId: 'openai' }),
    ];
    const { verifyCalls, verifyProvider } = makeVerifier('verified');
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={verifyProvider} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));
    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );

    // Stand in for a successful inline save inside the Credential Inventory:
    // it stores the key and bumps secretsVersion.
    sources = [{ provider: 'openai', source: 'stored' }];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await waitFor(() => expect(verifyCalls).toContain('openai'));
    expect(await screen.findByTestId('provider-models-openai')).toBeInTheDocument();
  });

  it('opens a collapsed card on a verified chain, and that card still collapses', async () => {
    let sources: unknown[] = [];
    installSecretsBridge(() => Promise.resolve(sources));
    currentModels = [model({ id: 'gpt-5.2', name: 'GPT-5.2', providerId: 'openai' })];
    const { verifyProvider } = makeVerifier('verified');
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={verifyProvider} />);
    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );

    sources = [{ provider: 'openai', source: 'stored' }];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    // The chain opens the card the credential arrived for…
    const body = await screen.findByTestId('provider-card-body-openai');
    expect(body).toBeInTheDocument();

    // …and the toggle must still work afterwards. Deriving `isOpen` from the
    // chain verdict pinned it open forever and made this control inert.
    await user.click(screen.getByTestId('provider-card-toggle-openai'));
    await waitFor(() =>
      expect(screen.queryByTestId('provider-card-body-openai')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('provider-card-toggle-openai')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('keeps at most one card open when a chain fires while another is expanded', async () => {
    let sources: unknown[] = [];
    installSecretsBridge(() => Promise.resolve(sources));
    const { verifyProvider } = makeVerifier('verified');
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={verifyProvider} />);
    await user.click(await screen.findByTestId('provider-card-toggle-anthropic'));
    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );

    sources = [{ provider: 'openai', source: 'stored' }];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await screen.findByTestId('provider-card-body-openai');
    expect(screen.queryByTestId('provider-card-body-anthropic')).not.toBeInTheDocument();
  });

  it('shows a failed auto-probe on the COLLAPSED card', async () => {
    // The chain probe fires on a credential arriving, which can happen while
    // the card is closed. Without a verdict on the card face, an automatic
    // check could fail with nothing on screen to say so.
    let sources: unknown[] = [];
    installSecretsBridge(() => Promise.resolve(sources));
    const { verifyProvider } = makeVerifier('invalid');

    render(<ProvidersSettings verifyProvider={verifyProvider} />);
    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );

    sources = [{ provider: 'openai', source: 'stored' }];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    const chip = await screen.findByTestId('provider-verdict-chip-openai');
    expect(chip).toHaveAttribute('data-status', 'invalid');
    // Still collapsed — the verdict is legible without opening anything.
    expect(screen.queryByTestId('provider-card-body-openai')).not.toBeInTheDocument();
  });

  it('never reads a credential the provider rejected as connected (BST-1981)', async () => {
    let sources: unknown[] = [];
    installSecretsBridge(() => Promise.resolve(sources));
    const { verifyProvider } = makeVerifier('invalid');

    render(<ProvidersSettings verifyProvider={verifyProvider} />);
    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );
    sources = [{ provider: 'openai', source: 'stored' }];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await screen.findByTestId('provider-verdict-chip-openai');
    const connection = screen.getByTestId('provider-connection-openai');
    // The key is still stored, but the runtime cannot authenticate with it.
    expect(connection).toHaveAttribute('data-connection', 'connected');
    expect(connection).toHaveAttribute('data-verdict', 'invalid');
    expect(connection).toHaveTextContent('Key rejected');
    expect(connection).not.toHaveTextContent('Connected');
  });

  it('does not open the model list when the probe rejects the credential', async () => {
    let sources: unknown[] = [];
    installSecretsBridge(() => Promise.resolve(sources));
    currentModels = [model({ id: 'gpt-5.2', providerId: 'openai' })];
    const { verifyCalls, verifyProvider } = makeVerifier('invalid');

    render(<ProvidersSettings verifyProvider={verifyProvider} />);
    // The card is never expanded, so only the chaining could reveal models.
    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );

    sources = [{ provider: 'openai', source: 'stored' }];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await waitFor(() => expect(verifyCalls).toContain('openai'));
    expect(screen.queryByTestId('provider-models-openai')).not.toBeInTheDocument();
  });

  it('returns the card to disconnected and drops the verdict on disconnect', async () => {
    let sources: unknown[] = [{ provider: 'openai', source: 'stored' }];
    installSecretsBridge(() => Promise.resolve(sources));
    const { verifyProvider } = makeVerifier('verified');
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={verifyProvider} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));
    await user.click(screen.getByTestId('provider-test-connection-openai'));
    expect(await screen.findByTestId('provider-verification-openai')).toBeInTheDocument();

    // The row's Remove button deletes the key and bumps secretsVersion.
    sources = [];
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'disconnected'
      )
    );
    expect(screen.queryByTestId('provider-verification-openai')).not.toBeInTheDocument();
  });
});

describe('ProvidersSettings — models', () => {
  it('toggles a model through the registry store', async () => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openai', source: 'stored' }]));
    currentModels = [model({ id: 'gpt-5.2', name: 'GPT-5.2', providerId: 'openai' })];
    const user = userEvent.setup();

    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));
    await user.click(await screen.findByTestId('provider-model-toggle-gpt-5.2'));

    expect(toggleModelMock).toHaveBeenCalledWith(expect.anything(), 'gpt-5.2', true);
  });
});

describe('ProvidersSettings — web (real wiring)', () => {
  // The web settings page renders `<ProvidersSettings verifyProvider={…} />`
  // and nothing else: no secrets bridge, no status sources. These assertions
  // therefore describe what web users ACTUALLY see.
  it('never claims providers are disconnected when it has no source of truth', async () => {
    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await waitFor(() =>
      expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
        'data-connection',
        'unknown'
      )
    );
    // A permanent "connect your first provider" panel on a deployment whose
    // keys live in the server environment is a lie about state we cannot read.
    expect(screen.queryByTestId('provider-recommendations')).not.toBeInTheDocument();
  });

  it('says plainly that status cannot be read here', async () => {
    const user = userEvent.setup();
    render(<ProvidersSettings verifyProvider={idleVerifier} />);

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));

    expect(screen.getByTestId('provider-readonly-note-openai')).toHaveTextContent(
      /status unavailable here/i
    );
    expect(screen.getByTestId('provider-key-source-openai')).toHaveTextContent(/unavailable/i);
  });
});

describe('ProvidersSettings — web', () => {
  it('renders read-only status with no credential editors when no secrets bridge exists', async () => {
    const user = userEvent.setup();

    render(
      <ProvidersSettings
        statusProviderKeySources={[{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }]}
        verifyProvider={idleVerifier}
      />
    );

    await user.click(await screen.findByTestId('provider-card-toggle-openai'));

    expect(screen.getByTestId('provider-readonly-note-openai')).toHaveTextContent(
      /server environment/i
    );
    expect(screen.queryByTestId('credential-row-openai')).not.toBeInTheDocument();
    expect(screen.getByTestId('provider-connection-openai')).toHaveAttribute(
      'data-connection',
      'connected'
    );
  });
});
