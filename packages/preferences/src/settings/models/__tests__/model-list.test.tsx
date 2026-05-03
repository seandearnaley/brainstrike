import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbModel, DbProvider } from '../../../stores/model-registry-store';
import { ModelList } from '../model-list';

beforeAll(() => {
  if (typeof global.ResizeObserver === 'undefined') {
    // Polyfill for Radix ScrollArea used in ModelList
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    global.ResizeObserver = ResizeObserver;
  }
});

const providers: DbProvider[] = [
  { id: 'local', name: 'Local', icon: null, isEnabled: true, sortOrder: 0 },
  { id: 'transformers', name: 'Transformers', icon: null, isEnabled: true, sortOrder: 1 },
  { id: 'openai', name: 'OpenAI', icon: null, isEnabled: true, sortOrder: 2 },
];

const baseModels: DbModel[] = [
  {
    id: 'local-ready',
    providerId: 'local',
    name: 'Local Ready',
    description: 'Local embedding model',
    tagline: null,
    bestFor: null,
    icon: null,
    isEnabled: true,
    capabilities: { type: 'embedding', streaming: false },
    parameters: null,
    sortOrder: 0,
  },
  {
    id: 'local-downloading',
    providerId: 'local',
    name: 'Local Downloading',
    description: 'Downloading',
    tagline: null,
    bestFor: null,
    icon: null,
    isEnabled: false,
    capabilities: { type: 'embedding', streaming: false },
    parameters: null,
    sortOrder: 1,
  },
  {
    id: 'transformers-stream',
    providerId: 'transformers',
    name: 'HF Stream Model',
    description: 'HF embeddings',
    tagline: null,
    bestFor: null,
    icon: null,
    isEnabled: false,
    capabilities: { type: 'embedding', streaming: true },
    parameters: null,
    sortOrder: 2,
  },
  {
    id: 'gpt-5.2',
    providerId: 'openai',
    name: 'GPT-5.2',
    description: 'Chat model',
    tagline: null,
    bestFor: null,
    icon: null,
    isEnabled: false,
    capabilities: { type: 'llm', streaming: false },
    parameters: null,
    sortOrder: 3,
  },
  {
    id: 'text-embed',
    providerId: 'openai',
    name: 'OpenAI Embed',
    description: 'Remote embedding model',
    tagline: null,
    bestFor: null,
    icon: null,
    isEnabled: false,
    capabilities: { type: 'embedding', streaming: false },
    parameters: null,
    sortOrder: 3,
  },
  {
    id: 'mystery-model',
    providerId: 'missing-provider',
    name: 'Mystery Model',
    description: 'Unknown provider model',
    tagline: null,
    bestFor: null,
    icon: null,
    isEnabled: false,
    capabilities: { type: 'llm', streaming: false },
    parameters: null,
    sortOrder: 4,
  },
];

const makeProps = () => {
  const onToggle = vi.fn();
  const onDownload = vi.fn();

  return {
    models: baseModels,
    providers,
    onToggle,
    onDownload,
    isDownloading: {
      'local-downloading': true,
    },
    downloadProgress: {
      'local-downloading': 25,
    },
    downloadedModels: {
      'transformers-stream': true,
    },
    modelCacheDir: '/models',
    onToggleSpy: onToggle,
    onDownloadSpy: onDownload,
  } as const;
};

describe('ModelList', () => {
  it('filters by search, switches tabs, and shows empty state', async () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} />);

    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('Unknown Provider')).toBeTruthy();

    const searchInput = screen.getByPlaceholderText('Search models, providers, or tags');
    await userEvent.clear(searchInput);
    await userEvent.type(searchInput, 'gpt');

    expect(screen.getByText('GPT-5.2')).toBeTruthy();
    expect(screen.queryByText('Local Ready')).toBeNull();

    // Switch to embeddings tab -> no matches for GPT
    await userEvent.click(screen.getByRole('tab', { name: 'Embeddings' }));
    expect(screen.getByText('No models match this search yet.')).toBeTruthy();

    await userEvent.clear(searchInput);
    expect(screen.getByText('Local Ready')).toBeTruthy();
    expect(screen.getByText('HF Stream Model')).toBeTruthy();

    // Ensure callback spies unused in this flow
    expect(onToggleSpy).not.toHaveBeenCalled();
    expect(onDownloadSpy).not.toHaveBeenCalled();
  });

  it('toggles local and remote filters', async () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Embeddings' }));

    const remoteButton = screen.getByRole('button', { name: /Remote/i });
    const localButton = screen.getByRole('button', { name: /Local/i });

    expect(screen.getByTestId('model-row-text-embed')).toBeTruthy();
    expect(screen.getByTestId('model-row-local-ready')).toBeTruthy();

    await userEvent.click(remoteButton);
    expect(screen.queryByTestId('model-row-text-embed')).toBeNull();
    expect(screen.getByTestId('model-row-local-ready')).toBeTruthy();

    await userEvent.click(localButton);
    expect(screen.getByText('Enable Local or Remote to view models.')).toBeTruthy();

    await userEvent.click(remoteButton);
    expect(screen.getByTestId('model-row-text-embed')).toBeTruthy();
    expect(screen.queryByTestId('model-row-local-ready')).toBeNull();

    expect(onToggleSpy).not.toHaveBeenCalled();
    expect(onDownloadSpy).not.toHaveBeenCalled();
  });

  it('renders download states and toggles models', async () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Embeddings' }));

    const downloadingRow = screen.getByTestId('model-row-local-downloading');
    expect(within(downloadingRow).getByText('25% downloaded')).toBeTruthy();

    // Downloaded badge with cache path
    const hfRow = screen.getByTestId('model-row-transformers-stream');
    expect(within(hfRow).getByText('Downloaded')).toBeTruthy();
    expect(within(hfRow).getByText('/models/transformers-stream')).toBeTruthy();

    // Download button path for a local model not yet downloaded
    const readyRow = screen.getByTestId('model-row-local-ready');
    const downloadBtn = within(readyRow).getByRole('button', { name: 'Download' });
    await userEvent.click(downloadBtn);
    expect(onDownloadSpy).toHaveBeenCalledWith('local-ready');

    // Hosted provider should not render download controls
    await userEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    const gptRow = screen.getByTestId('model-row-gpt-5.2');
    expect(within(gptRow).queryByRole('button', { name: 'Download' })).toBeNull();

    // Toggle chat model on (was false)
    const gptSwitch = within(gptRow).getByRole('switch');
    await userEvent.click(gptSwitch);
    expect(onToggleSpy).toHaveBeenCalledWith('gpt-5.2', true);

    // Toggle enabled model off
    await userEvent.click(screen.getByRole('tab', { name: 'Embeddings' }));
    const readyRowAfter = screen.getByTestId('model-row-local-ready');
    const readySwitch = within(readyRowAfter).getByRole('switch');
    await userEvent.click(readySwitch);
    expect(onToggleSpy).toHaveBeenCalledWith('local-ready', false);
  });

  it('disables pending model toggles while persistence is in flight', () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} pendingModelIds={new Set(['gpt-5.2'])} />);

    const gptRow = screen.getByTestId('model-row-gpt-5.2');
    const gptSwitch = within(gptRow).getByRole('switch');

    expect(gptSwitch.hasAttribute('disabled')).toBe(true);
    expect(gptSwitch.getAttribute('aria-busy')).toBe('true');
    expect(onToggleSpy).not.toHaveBeenCalled();
    expect(onDownloadSpy).not.toHaveBeenCalled();
  });
});
