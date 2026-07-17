import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalDownloadIndicator } from '../components/global-download-indicator';
import { useModelRegistryStore } from '../stores/model-registry-store';

describe('GlobalDownloadIndicator', () => {
  afterEach(() => {
    act(() => {
      useModelRegistryStore.setState({
        downloadProgress: {},
        isDownloading: {},
      });
    });
  });

  it('uses a compact fixed footprint until the status bar has desktop width', () => {
    act(() => {
      useModelRegistryStore.setState({
        downloadProgress: { 'local-model': 42 },
        isDownloading: { 'local-model': true },
      });
    });

    render(<GlobalDownloadIndicator />);

    const label = screen.getByText('Downloading model…');
    const indicator = label.parentElement;
    expect(indicator).toHaveClass(
      'h-7',
      'w-14',
      'min-w-0',
      'overflow-hidden',
      'whitespace-nowrap',
      'lg:w-28',
      'xl:w-auto'
    );
    expect(label).toHaveClass('hidden', 'whitespace-nowrap', 'xl:block');
    expect(screen.getByRole('progressbar')).toHaveClass('w-8', 'lg:w-12');
    expect(screen.getByText('42%')).toHaveClass('sr-only', 'lg:not-sr-only', 'lg:w-8');
  });
});
