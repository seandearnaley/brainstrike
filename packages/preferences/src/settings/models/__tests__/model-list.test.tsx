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
  { icon: null, id: 'local', isEnabled: true, name: 'Local', sortOrder: 0 },
  { icon: null, id: 'transformers', isEnabled: true, name: 'Transformers', sortOrder: 1 },
  { icon: null, id: 'openai', isEnabled: true, name: 'OpenAI', sortOrder: 2 },
];

const baseModels: DbModel[] = [
  {
    bestFor: null,
    capabilities: { streaming: false, type: 'embedding' },
    description: 'Local embedding model',
    icon: null,
    id: 'local-ready',
    isEnabled: true,
    name: 'Local Ready',
    parameters: null,
    providerId: 'local',
    sortOrder: 0,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { streaming: false, type: 'embedding' },
    description: 'Downloading',
    icon: null,
    id: 'local-downloading',
    isEnabled: false,
    name: 'Local Downloading',
    parameters: null,
    providerId: 'local',
    sortOrder: 1,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { streaming: true, type: 'embedding' },
    description: 'HF embeddings',
    icon: null,
    id: 'transformers-stream',
    isEnabled: false,
    name: 'HF Stream Model',
    parameters: null,
    providerId: 'transformers',
    sortOrder: 2,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { streaming: false, type: 'llm' },
    description: 'Chat model',
    icon: null,
    id: 'gpt-5.2',
    isEnabled: false,
    name: 'GPT-5.2',
    parameters: null,
    providerId: 'openai',
    sortOrder: 3,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { streaming: false, type: 'embedding' },
    description: 'Remote embedding model',
    icon: null,
    id: 'text-embed',
    isEnabled: false,
    name: 'OpenAI Embed',
    parameters: null,
    providerId: 'openai',
    sortOrder: 3,
    tagline: null,
  },
  {
    bestFor: null,
    capabilities: { streaming: false, type: 'llm' },
    description: 'Unknown provider model',
    icon: null,
    id: 'mystery-model',
    isEnabled: false,
    name: 'Mystery Model',
    parameters: null,
    providerId: 'missing-provider',
    sortOrder: 4,
    tagline: null,
  },
];

const makeProps = () => {
  const onToggle = vi.fn();
  const onDownload = vi.fn();

  return {
    downloadedModels: {
      'transformers-stream': true,
    },
    downloadProgress: {
      'local-downloading': 25,
    },
    isDownloading: {
      'local-downloading': true,
    },
    modelCacheDir: '/models',
    models: baseModels,
    onDownload,
    onDownloadSpy: onDownload,
    onToggle,
    onToggleSpy: onToggle,
    providers,
  } as const;
};

describe('ModelList', () => {
  it('filters by search, switches tabs, and shows empty state', async () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} />);

    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('Unknown Provider')).toBeTruthy();

    const searchInput = screen.getByPlaceholderText('Search models, providers, or tags');
    expect(searchInput.className).toContain('pl-10');
    expect(searchInput.style.paddingLeft).toBe('2.5rem');
    expect(
      searchInput.parentElement?.querySelector<HTMLElement>('[data-slot="settings-search-icon"]')
        ?.style.left
    ).toBe('0.75rem');
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
