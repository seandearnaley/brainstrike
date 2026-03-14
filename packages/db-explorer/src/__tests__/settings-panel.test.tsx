import { fireEvent, render, screen } from '@testing-library/react';
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

  it('clamps token cap input to the supported bounds', () => {
    const setChunkTokenLimit = vi.fn();

    render(
      <SettingsPanel
        importSettings={createImportSettings({
          setChunkTokenLimit,
        })}
      />
    );

    const tokenCapInput = screen.getAllByRole('spinbutton').at(2);
    expect(tokenCapInput).toBeDefined();
    if (!tokenCapInput) {
      throw new Error('Expected token cap input to be rendered');
    }

    fireEvent.change(tokenCapInput, { target: { value: '999999' } });
    fireEvent.change(tokenCapInput, { target: { value: '0' } });

    expect(setChunkTokenLimit).toHaveBeenNthCalledWith(1, 16_384);
    expect(setChunkTokenLimit).toHaveBeenNthCalledWith(2, 512);
  });
});
