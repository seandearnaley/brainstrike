import '@testing-library/jest-dom/vitest';
import type { DeprecatedEnvVarReport } from '@brainstrike/assistant-contract';
import type {
  EnvBootstrapCapability,
  EnvBootstrapReport,
} from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { SECRETS_CHANGED_EVENT_NAME } from '@brainstrike/assistant-contract/provider-key-resolution';
import {
  providerDeprecatedEnvKeys,
  providerVendorEnvKey,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_OVERRIDE_ENV_KEY } from '@brainstrike/assistant-contract/tavily-env-keys';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentSection } from '../environment/environment-section';

vi.mock('@brainstrike/ui', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
    size?: string;
    variant?: string;
  }) => (
    <button data-testid={testId} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

const OPENAI_VENDOR_KEY = providerVendorEnvKey('openai') as string;
/** A genuinely RETIRED registry name — never a live vendor name. */
const OPENAI_DEPRECATED_KEY = providerDeprecatedEnvKeys('openai')[0] as string;

const OPENAI_DEPRECATION_REPORT: DeprecatedEnvVarReport = {
  envVar: OPENAI_DEPRECATED_KEY,
  provider: 'openai',
  replacement: OPENAI_VENDOR_KEY,
};

function report(overrides: Partial<EnvBootstrapReport> = {}): EnvBootstrapReport {
  return {
    appliedVariableCount: 0,
    credentialVariablesPresent: [],
    deprecatedVariablesInFiles: [],
    failures: [],
    loadedFiles: [],
    nonCredentialVariablesPresent: [],
    skipped: false,
    ...overrides,
  };
}

function installBridge(read: EnvBootstrapCapability['read']): void {
  (window as unknown as { envBootstrap?: EnvBootstrapCapability }).envBootstrap = { read };
}

function removeBridge(): void {
  Reflect.deleteProperty(window, 'envBootstrap');
}

afterEach(() => {
  removeBridge();
  vi.restoreAllMocks();
});

describe('EnvironmentSection', () => {
  it('renders nothing when the desktop bridge is absent (web)', () => {
    removeBridge();

    const { container } = render(<EnvironmentSection />);

    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes the development files that loaded and how many variables applied', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        report({
          appliedVariableCount: 3,
          loadedFiles: [
            { file: 'dev-local', path: '/app/.env.local' },
            { file: 'dev', path: '/app/.env' },
          ],
        })
      )
    );

    render(<EnvironmentSection />);

    await waitFor(() => {
      expect(screen.getByTestId('env-bootstrap-summary')).toHaveTextContent(
        'Environment: .env.local + .env loaded, 3 variables applied'
      );
    });
  });

  it('summarizes the packaged user-data file', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        report({
          appliedVariableCount: 1,
          loadedFiles: [{ file: 'user-data', path: '/userdata/.env' }],
        })
      )
    );

    render(<EnvironmentSection />);

    await waitFor(() => {
      expect(screen.getByTestId('env-bootstrap-summary')).toHaveTextContent(
        'Environment: user-data .env loaded, 1 variable applied'
      );
    });
  });

  it('reports test mode as disabled rather than as an empty environment', async () => {
    installBridge(vi.fn().mockResolvedValue(report({ skipped: true })));

    render(<EnvironmentSection />);

    await waitFor(() => {
      expect(screen.getByTestId('env-bootstrap-summary')).toHaveTextContent(
        'Environment files disabled (test mode)'
      );
    });
  });

  it('states the restart requirement explicitly', async () => {
    installBridge(vi.fn().mockResolvedValue(report()));

    render(<EnvironmentSection />);

    await waitFor(() => {
      expect(screen.getByTestId('env-bootstrap-restart-note')).toHaveTextContent(
        'Changes to environment files apply after restart.'
      );
    });
  });

  it('reads once on mount and does NOT re-read on focus or secrets changes', async () => {
    // The projection is derived from the recorded bootstrap plus process env,
    // and neither can change without a restart — so a re-read could only ever
    // return the same payload. Advertising a live refresh would be a lie.
    const read = vi.fn().mockResolvedValue(report());
    installBridge(read);

    render(<EnvironmentSection />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    fireEvent(window, new Event(SECRETS_CHANGED_EVENT_NAME));
    fireEvent(window, new Event('focus'));

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  });

  describe('parse failures', () => {
    const failureReport = report({
      failures: [
        {
          code: 'env_file_invalid',
          file: 'dev-local',
          message:
            'Desktop environment file ".env.local" is invalid at line 4: unsupported variable name.',
          path: '/app/.env.local',
        },
      ],
    });

    it('shows the parser line-precise message with no raw file id', async () => {
      installBridge(vi.fn().mockResolvedValue(failureReport));

      render(<EnvironmentSection />);

      const banner = await screen.findByTestId('env-bootstrap-failure-dev-local');
      expect(banner).toHaveTextContent(
        'Desktop environment file ".env.local" is invalid at line 4: unsupported variable name.'
      );
      expect(banner).toHaveTextContent('.env.local');
      // The loader's file IDS must never surface as user-facing text.
      expect(banner.textContent).not.toMatch(/\bdev-local\b/);
      expect(banner.textContent).not.toMatch(/"dev"/);
    });

    it('states the all-or-nothing consequence, not merely a per-file one', async () => {
      installBridge(vi.fn().mockResolvedValue(failureReport));

      render(<EnvironmentSection />);

      const banner = await screen.findByTestId('env-bootstrap-failure-dev-local');
      expect(banner).toHaveTextContent(
        'No environment file was applied — one invalid file discards them all.'
      );
    });
  });

  describe('open folder', () => {
    const userDataLoaded = report({
      loadedFiles: [{ file: 'user-data', path: '/userdata/.env' }],
    });

    it('reveals the user-data file and hides the action without the capability', async () => {
      const onRevealPath = vi.fn().mockResolvedValue({ ok: true });
      installBridge(vi.fn().mockResolvedValue(userDataLoaded));

      const { rerender } = render(<EnvironmentSection onRevealPath={onRevealPath} />);

      fireEvent.click(await screen.findByTestId('env-bootstrap-open-folder'));
      expect(onRevealPath).toHaveBeenCalledWith('/userdata/.env');

      rerender(<EnvironmentSection />);
      await waitFor(() => {
        expect(screen.queryByTestId('env-bootstrap-open-folder')).toBeNull();
      });
    });

    it('offers Open folder for a user-data file that FAILED to parse', async () => {
      const onRevealPath = vi.fn().mockResolvedValue({ ok: true });
      installBridge(
        vi.fn().mockResolvedValue(
          report({
            failures: [
              {
                code: 'env_file_invalid',
                file: 'user-data',
                message:
                  'Desktop environment file "user-data .env" is invalid at line 2: expected "=".',
                path: '/userdata/.env',
              },
            ],
          })
        )
      );

      render(<EnvironmentSection onRevealPath={onRevealPath} />);

      fireEvent.click(await screen.findByTestId('env-bootstrap-open-folder'));
      expect(onRevealPath).toHaveBeenCalledWith('/userdata/.env');
    });

    it('surfaces a failed reveal naming the path instead of doing nothing', async () => {
      const onRevealPath = vi.fn().mockResolvedValue({ error: 'no such file', ok: false });
      installBridge(vi.fn().mockResolvedValue(userDataLoaded));

      render(<EnvironmentSection onRevealPath={onRevealPath} />);
      fireEvent.click(await screen.findByTestId('env-bootstrap-open-folder'));

      const error = await screen.findByTestId('env-bootstrap-reveal-error');
      expect(error).toHaveTextContent('/userdata/.env');
      expect(error).toHaveTextContent('no such file');
    });

    it('surfaces a rejected reveal instead of an unhandled rejection', async () => {
      const onRevealPath = vi.fn().mockRejectedValue(new Error('bridge died'));
      installBridge(vi.fn().mockResolvedValue(userDataLoaded));

      render(<EnvironmentSection onRevealPath={onRevealPath} />);
      fireEvent.click(await screen.findByTestId('env-bootstrap-open-folder'));

      const error = await screen.findByTestId('env-bootstrap-reveal-error');
      expect(error).toHaveTextContent('bridge died');
    });
  });

  describe('effective variable chips', () => {
    it('renders credential and non-credential chips distinctly and links credentials to their row', async () => {
      const onSelectCredentialSlot = vi.fn();
      installBridge(
        vi.fn().mockResolvedValue(
          report({
            credentialVariablesPresent: [OPENAI_VENDOR_KEY],
            nonCredentialVariablesPresent: ['AWS_REGION'],
          })
        )
      );

      render(<EnvironmentSection onSelectCredentialSlot={onSelectCredentialSlot} />);

      const credentialChip = await screen.findByTestId(`env-bootstrap-chip-${OPENAI_VENDOR_KEY}`);
      const configChip = screen.getByTestId('env-bootstrap-chip-AWS_REGION');

      expect(credentialChip).toHaveAttribute('data-variable-kind', 'credential');
      expect(configChip).toHaveAttribute('data-variable-kind', 'config');
      expect(credentialChip.className).not.toBe(configChip.className);

      fireEvent.click(credentialChip);
      expect(onSelectCredentialSlot).toHaveBeenCalledWith('openai');
    });

    it('links the Tavily override name to the Tavily slot via the canonical key list', async () => {
      const onSelectCredentialSlot = vi.fn();
      installBridge(
        vi.fn().mockResolvedValue(report({ credentialVariablesPresent: [TAVILY_OVERRIDE_ENV_KEY] }))
      );

      render(<EnvironmentSection onSelectCredentialSlot={onSelectCredentialSlot} />);

      fireEvent.click(await screen.findByTestId(`env-bootstrap-chip-${TAVILY_OVERRIDE_ENV_KEY}`));
      expect(onSelectCredentialSlot).toHaveBeenCalledWith('tavily');
    });
  });

  describe('retired names', () => {
    it('warns with the SHARED report copy — the vendor name, never the BRAINSTRIKE_ override', async () => {
      installBridge(
        vi.fn().mockResolvedValue(
          report({
            credentialVariablesPresent: [OPENAI_DEPRECATED_KEY],
            deprecatedVariablesInFiles: [OPENAI_DEPRECATED_KEY],
          })
        )
      );

      render(<EnvironmentSection deprecatedEnvVars={[OPENAI_DEPRECATION_REPORT]} />);

      const warning = await screen.findByTestId(
        `env-bootstrap-deprecated-${OPENAI_DEPRECATED_KEY}`
      );
      expect(warning).toHaveTextContent(
        `${OPENAI_DEPRECATED_KEY} is set but no longer read — rename it to ${OPENAI_VENDOR_KEY}.`
      );
      expect(warning.textContent).not.toContain('BRAINSTRIKE_');
      expect(warning.className).toContain('amber');
    });

    it('adds a file-provenance clause when the name is spelled in an env file', async () => {
      installBridge(
        vi.fn().mockResolvedValue(
          report({
            credentialVariablesPresent: [OPENAI_DEPRECATED_KEY],
            deprecatedVariablesInFiles: [OPENAI_DEPRECATED_KEY],
          })
        )
      );

      render(<EnvironmentSection deprecatedEnvVars={[OPENAI_DEPRECATION_REPORT]} />);

      const warning = await screen.findByTestId(
        `env-bootstrap-deprecated-${OPENAI_DEPRECATED_KEY}`
      );
      expect(warning).toHaveTextContent('Your environment file still spells it.');
    });

    it('warns — never chips — a retired name set OUTSIDE any env file', async () => {
      // Exported from the user's shell: present in the environment, absent
      // from every env file. It still must not read as a working variable.
      installBridge(
        vi.fn().mockResolvedValue(
          report({
            credentialVariablesPresent: [OPENAI_DEPRECATED_KEY],
            deprecatedVariablesInFiles: [],
          })
        )
      );

      render(<EnvironmentSection deprecatedEnvVars={[OPENAI_DEPRECATION_REPORT]} />);

      const warning = await screen.findByTestId(
        `env-bootstrap-deprecated-${OPENAI_DEPRECATED_KEY}`
      );
      expect(warning).toHaveTextContent(`rename it to ${OPENAI_VENDOR_KEY}`);
      expect(warning.textContent).not.toContain('Your environment file still spells it.');
      expect(screen.queryByTestId(`env-bootstrap-chip-${OPENAI_DEPRECATED_KEY}`)).toBeNull();
    });
  });

  it('surfaces a bridge read failure instead of rendering an empty environment', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('bridge exploded')));

    render(<EnvironmentSection />);

    await waitFor(() => {
      expect(screen.getByTestId('env-bootstrap-error')).toHaveTextContent('bridge exploded');
    });
    expect(screen.queryByTestId('env-bootstrap-summary')).toBeNull();
  });
});
