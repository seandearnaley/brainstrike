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
    id: 'gpt-3.5',
    providerId: 'openai',
    name: 'GPT Chat',
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

function findCard(title: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(title);
  while (el && !(el.className?.includes('justify-between') && el.className?.includes('p-3'))) {
    el = el.parentElement as HTMLElement | null;
  }
  if (!el) {
    throw new Error(`Card for "${title}" not found`);
  }
  return el;
}

describe('ModelList', () => {
  it('filters by search and type and shows empty state', async () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} />);

    // Initial groups render
    expect(screen.getByText('Local')).toBeTruthy();
    expect(screen.getByText('Transformers')).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('Unknown Provider')).toBeTruthy();

    const searchInput = screen.getByPlaceholderText('Search models...');
    await userEvent.clear(searchInput);
    await userEvent.type(searchInput, 'gpt');

    expect(screen.getByText('GPT Chat')).toBeTruthy();
    expect(screen.queryByText('Local Ready')).toBeNull();

    // Switch to embedding filter -> no chat models should remain
    await userEvent.click(screen.getByRole('button', { name: 'Embedding' }));
    expect(screen.getByText('No models found matching your filters.')).toBeTruthy();

    // Switch to chat filter -> chat model returns
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByText('GPT Chat')).toBeTruthy();

    // Ensure callback spies unused in this flow
    expect(onToggleSpy).not.toHaveBeenCalled();
    expect(onDownloadSpy).not.toHaveBeenCalled();
  });

  it('renders download states and toggles models', async () => {
    const { onToggleSpy, onDownloadSpy, ...props } = makeProps();
    render(<ModelList {...props} />);

    // Download in-progress path
    expect(screen.getByText('25%')).toBeTruthy();

    // Downloaded badge with cache path
    const hfCard = findCard('HF Stream Model');
    expect(within(hfCard).getByText('Downloaded')).toBeTruthy();
    expect(within(hfCard).getByText('/models/transformers-stream')).toBeTruthy();

    // Download button path for a local model not yet downloaded
    const readyCard = findCard('Local Ready');
    const downloadBtn = within(readyCard).getByRole('button');
    await userEvent.click(downloadBtn);
    expect(onDownloadSpy).toHaveBeenCalledWith('local-ready');

    // Hosted provider should not render download controls
    const gptCard = findCard('GPT Chat');
    expect(within(gptCard).queryByRole('button')).toBeNull();

    // Toggle chat model on (was false)
    const gptSwitch = within(gptCard).getByRole('switch');
    await userEvent.click(gptSwitch);
    expect(onToggleSpy).toHaveBeenCalledWith('gpt-3.5', true);

    // Toggle enabled model off
    const readySwitch = within(readyCard).getByRole('switch');
    await userEvent.click(readySwitch);
    expect(onToggleSpy).toHaveBeenCalledWith('local-ready', false);
  });
});
