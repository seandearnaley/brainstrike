import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../components/settings-panel';
import type { ImportSettings } from '../types';

function createImportSettings(overrides: Partial<ImportSettings> = {}): ImportSettings {
  return {
    chunkingPreset: 'balanced',
    chunkingStrategy: 'auto',
    chunkingStrategyExplicit: false,
    chunkOverlap: 50,
    chunkSize: 256,
    chunkTokenLimit: 4096,
    enableChunking: true,
    setChunkingPreset: () => {},
    setChunkingStrategy: () => {},
    setChunkOverlap: () => {},
    setChunkSize: () => {},
    setChunkTokenLimit: () => {},
    setEnableChunking: () => {},
    setTokenTrueSizing: () => {},
    tokenTrueSizing: true,
    ...overrides,
  };
}

describe('SettingsPanel', () => {
  it('renders an explicit invalid-settings error instead of throwing on unknown strategies', () => {
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingStrategy: 'bogus' as ImportSettings['chunkingStrategy'],
        })}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Chunking Studio configuration error');
    expect(screen.getByRole('alert')).toHaveTextContent('bogus');
  });

  it('renders the active preset chip in the header', () => {
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'codebase',
          chunkingStrategy: 'auto',
        })}
      />
    );

    const chip = screen.getByTestId('chunking-active-preset');
    expect(chip).toHaveTextContent(/codebase/i);
    expect(chip).toHaveTextContent(/adaptive/i);
  });

  it('renders the custom-tuning chip when no preset is active', () => {
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'custom',
        })}
      />
    );

    const chip = screen.getByTestId('chunking-active-preset');
    expect(chip).toHaveTextContent(/custom/i);
  });

  it('exposes preset status text for every preset (Adaptive/Fixed + strategy)', () => {
    render(<SettingsPanel importSettings={createImportSettings()} />);

    const balancedStatus = screen.getByTestId('chunking-preset-status-balanced');
    expect(balancedStatus).toHaveTextContent(/Adaptive/i);
    expect(balancedStatus).toHaveTextContent(/auto/i);

    const strictStatus = screen.getByTestId('chunking-preset-status-strict-code');
    expect(strictStatus).toHaveTextContent(/Fixed/i);
    expect(strictStatus).toHaveTextContent(/recursive/i);
  });

  it('marks the active preset button with aria-pressed=true', () => {
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'docs',
        })}
      />
    );

    expect(screen.getByTestId('chunking-preset-docs')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chunking-preset-balanced')).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides advanced controls behind a disclosure when on a preset', async () => {
    const user = userEvent.setup();
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'balanced',
        })}
      />
    );

    expect(screen.queryByLabelText(/^Chunk size$/)).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /advanced controls/i });
    await user.click(toggle);

    expect(screen.getByLabelText(/^Chunk size$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Overlap$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Token cap$/)).toBeInTheDocument();
  });

  it('auto-expands advanced controls when on the custom preset', () => {
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'custom',
        })}
      />
    );

    expect(screen.getByLabelText(/^Chunk size$/)).toBeInTheDocument();
  });

  it('clamps token cap input to the supported bounds', () => {
    // Uses fireEvent.change rather than userEvent.type because the clamp
    // semantics are about the final value of the input — userEvent.type would
    // fire one change event per digit and exercise the clamp on intermediate
    // values, which is a different contract.
    const setChunkTokenLimit = vi.fn();

    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'custom',
          setChunkTokenLimit,
        })}
      />
    );

    const tokenCapInput = screen.getByLabelText(/^Token cap$/);

    fireEvent.change(tokenCapInput, { target: { value: '999999' } });
    fireEvent.change(tokenCapInput, { target: { value: '0' } });

    expect(setChunkTokenLimit).toHaveBeenNthCalledWith(1, 16_384);
    expect(setChunkTokenLimit).toHaveBeenNthCalledWith(2, 512);
  });

  it('hides routing plan behind a disclosure', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel importSettings={createImportSettings()} />);

    expect(screen.queryByText('Code module')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /routing plan/i }));

    expect(screen.getByText('Code module')).toBeInTheDocument();
  });

  it('toggles enable-chunking via the labelled switch', async () => {
    const user = userEvent.setup();
    const setEnableChunking = vi.fn();

    render(
      <SettingsPanel
        importSettings={createImportSettings({
          enableChunking: true,
          setEnableChunking,
        })}
      />
    );

    const toggle = screen.getByLabelText('Enable chunking');
    await user.click(toggle);

    expect(setEnableChunking).toHaveBeenCalledWith(false);
  });
});
