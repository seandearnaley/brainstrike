import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../components/settings-panel';
import type { ImportSettings } from '../types';

function createImportSettings(overrides: Partial<ImportSettings> = {}): ImportSettings {
  return {
    chunkingPreset: 'balanced',
    chunkingSettingsRepairs: [],
    chunkingStrategy: 'auto',
    chunkingStrategyExplicit: false,
    chunkOverlap: 50,
    chunkSize: 256,
    chunkTokenLimit: 4096,
    dismissChunkingSettingsRepairs: () => {},
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

  // BST-423. This test previously asserted that the panel CLAMPED — that
  // typing 999999 called the store with 16384 and typing 0 called it with 512.
  // That silently discarded what the user typed, and it duplicated the store's
  // own clamp with subtly different NaN handling, which is how the two copies
  // drifted apart unnoticed: each had its own green test certifying itself.
  it('rejects out-of-range token cap input instead of clamping it', () => {
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
    expect(setChunkTokenLimit).not.toHaveBeenCalled();
    expect(screen.getByText(/Token cap must be at most 16384/)).toBeInTheDocument();

    fireEvent.change(tokenCapInput, { target: { value: '0' } });
    expect(setChunkTokenLimit).not.toHaveBeenCalled();
    expect(screen.getByText(/Token cap must be at least 512/)).toBeInTheDocument();
  });

  it('commits a valid token cap and clears the error', () => {
    const setChunkTokenLimit = vi.fn();
    render(
      <SettingsPanel
        importSettings={createImportSettings({ chunkingPreset: 'custom', setChunkTokenLimit })}
      />
    );

    const tokenCapInput = screen.getByLabelText(/^Token cap$/);
    fireEvent.change(tokenCapInput, { target: { value: '999999' } });
    expect(screen.getByText(/at most 16384/)).toBeInTheDocument();

    fireEvent.change(tokenCapInput, { target: { value: '8192' } });
    expect(setChunkTokenLimit).toHaveBeenCalledWith(8192);
    expect(screen.queryByText(/at most 16384/)).not.toBeInTheDocument();
  });

  it('lets a user type through intermediate invalid states without losing input', () => {
    // Typing "512" passes through "5" and "51", both below the minimum. A
    // controlled input that refused to hold those would make the field
    // impossible to type into — the reason the draft state exists.
    const setChunkTokenLimit = vi.fn();
    render(
      <SettingsPanel
        importSettings={createImportSettings({ chunkingPreset: 'custom', setChunkTokenLimit })}
      />
    );

    const tokenCapInput = screen.getByLabelText(/^Token cap$/) as HTMLInputElement;
    fireEvent.change(tokenCapInput, { target: { value: '5' } });
    expect(tokenCapInput.value).toBe('5');
    fireEvent.change(tokenCapInput, { target: { value: '51' } });
    expect(tokenCapInput.value).toBe('51');
    fireEvent.change(tokenCapInput, { target: { value: '512' } });
    expect(tokenCapInput.value).toBe('512');
    expect(setChunkTokenLimit).toHaveBeenCalledTimes(1);
    expect(setChunkTokenLimit).toHaveBeenCalledWith(512);
  });

  it('rejects an emptied or non-numeric field without calling the store', () => {
    // `Number('')` is 0 and `Number('abc')` is NaN. Both used to reach the
    // store and be absorbed into a default.
    const setChunkSize = vi.fn();
    render(
      <SettingsPanel
        importSettings={createImportSettings({ chunkingPreset: 'custom', setChunkSize })}
      />
    );

    const sizeInput = screen.getByLabelText(/^Chunk size$/);
    fireEvent.change(sizeInput, { target: { value: '' } });
    expect(setChunkSize).not.toHaveBeenCalled();
    expect(screen.getByText(/Chunk size must be a number/)).toBeInTheDocument();
  });

  it('enforces the cross-field overlap invariant in the UI, not just the store', () => {
    // Overlap 256 with size 256 is two individually-valid numbers that are
    // impossible together. The UI must catch it rather than letting the store
    // throw out of an onChange handler.
    const setChunkOverlap = vi.fn();
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingPreset: 'custom',
          chunkSize: 256,
          setChunkOverlap,
        })}
      />
    );

    const overlapInput = screen.getByLabelText(/^Overlap$/);
    fireEvent.change(overlapInput, { target: { value: '256' } });
    expect(setChunkOverlap).not.toHaveBeenCalled();
    expect(screen.getByText(/smaller than chunk size/)).toBeInTheDocument();
  });

  it('surfaces repaired persisted settings and lets the user dismiss the notice', () => {
    const dismissChunkingSettingsRepairs = vi.fn();
    render(
      <SettingsPanel
        importSettings={createImportSettings({
          chunkingSettingsRepairs: [
            {
              discardedValue: 4,
              field: 'chunkSize',
              message: 'Chunk size must be at least 128.',
              repairedTo: 256,
            },
          ],
          dismissChunkingSettingsRepairs,
        })}
      />
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Chunk size must be at least 128.');
    expect(notice).toHaveTextContent('4');
    expect(notice).toHaveTextContent('256');

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(dismissChunkingSettingsRepairs).toHaveBeenCalled();
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
