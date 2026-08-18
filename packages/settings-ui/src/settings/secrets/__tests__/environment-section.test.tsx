import '@testing-library/jest-dom/vitest';
import type {
  EnvBootstrapCapability,
  EnvBootstrapReport,
} from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { SECRETS_CHANGED_EVENT_NAME } from '@brainstrike/assistant-contract/provider-key-resolution';
import {
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
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

const OPENAI_OVERRIDE_KEY = providerEnvKeys('openai')[0] as string;
/** A genuinely RETIRED name from the registry — never a live vendor name. */
const OPENAI_DEPRECATED_KEY = providerDeprecatedEnvKeys('openai')[0] as string;

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

  it('shows the parser line-precise message for every failed file', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        report({
          failures: [
            {
              code: 'env_file_invalid',
              file: 'dev-local',
              message:
                'Desktop environment file "dev-local" is invalid at line 4: unsupported variable name.',
              path: '/app/.env.local',
            },
          ],
        })
      )
    );

    render(<EnvironmentSection />);

    const banner = await screen.findByTestId('env-bootstrap-failure-dev-local');
    expect(banner).toHaveTextContent(
      'Desktop environment file "dev-local" is invalid at line 4: unsupported variable name.'
    );
    expect(banner).toHaveTextContent('.env.local');
  });

  it('offers Open folder for the user-data file only when the shell capability is injected', async () => {
    const onRevealPath = vi.fn();
    installBridge(
      vi
        .fn()
        .mockResolvedValue(report({ loadedFiles: [{ file: 'user-data', path: '/userdata/.env' }] }))
    );

    const { rerender } = render(<EnvironmentSection onRevealPath={onRevealPath} />);

    fireEvent.click(await screen.findByTestId('env-bootstrap-open-folder'));
    expect(onRevealPath).toHaveBeenCalledWith('/userdata/.env');

    rerender(<EnvironmentSection />);
    await waitFor(() => {
      expect(screen.queryByTestId('env-bootstrap-open-folder')).toBeNull();
    });
  });

  it('offers Open folder for a user-data file that FAILED to parse', async () => {
    const onRevealPath = vi.fn();
    installBridge(
      vi.fn().mockResolvedValue(
        report({
          failures: [
            {
              code: 'env_file_invalid',
              file: 'user-data',
              message: 'Desktop environment file "user-data" is invalid at line 2: expected "=".',
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

  it('renders credential and non-credential chips distinctly and links credentials to their row', async () => {
    const onSelectCredentialSlot = vi.fn();
    installBridge(
      vi.fn().mockResolvedValue(
        report({
          credentialVariablesPresent: [OPENAI_OVERRIDE_KEY],
          nonCredentialVariablesPresent: ['AWS_REGION'],
        })
      )
    );

    render(<EnvironmentSection onSelectCredentialSlot={onSelectCredentialSlot} />);

    const credentialChip = await screen.findByTestId(`env-bootstrap-chip-${OPENAI_OVERRIDE_KEY}`);
    const configChip = screen.getByTestId('env-bootstrap-chip-AWS_REGION');

    expect(credentialChip).toHaveAttribute('data-variable-kind', 'credential');
    expect(configChip).toHaveAttribute('data-variable-kind', 'config');
    expect(credentialChip.className).not.toBe(configChip.className);

    fireEvent.click(credentialChip);
    expect(onSelectCredentialSlot).toHaveBeenCalledWith('openai');
  });

  it('marks deprecated names and names their replacement', async () => {
    installBridge(
      vi.fn().mockResolvedValue(
        report({
          credentialVariablesPresent: [OPENAI_DEPRECATED_KEY],
          deprecatedVariablesInFiles: [OPENAI_DEPRECATED_KEY],
        })
      )
    );

    render(<EnvironmentSection />);

    const deprecated = await screen.findByTestId(
      `env-bootstrap-deprecated-${OPENAI_DEPRECATED_KEY}`
    );
    expect(deprecated).toHaveTextContent(OPENAI_DEPRECATED_KEY);
    expect(deprecated).toHaveTextContent(OPENAI_OVERRIDE_KEY);
    expect(deprecated.className).toContain('amber');
    // The deprecated name is not ALSO rendered as an ordinary chip.
    expect(screen.queryByTestId(`env-bootstrap-chip-${OPENAI_DEPRECATED_KEY}`)).toBeNull();
  });

  it('re-reads on a secrets-changed event and on window focus', async () => {
    const read = vi.fn().mockResolvedValue(report());
    installBridge(read);

    render(<EnvironmentSection />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    fireEvent(window, new Event(SECRETS_CHANGED_EVENT_NAME));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
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
