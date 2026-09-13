import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugBundleProvider } from '../debug-bundle-context';
import { ThreadDebugPackButton } from '../thread-debug-pack-button';

const save = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/utils/browser-download', () => ({
  downloadBlobFile: save,
  formatTimestampedDownloadFilename: () => 'thread-debug.json',
}));

describe('thread debug pack', () => {
  beforeEach(() => {
    save.mockReset();
  });
  it('shows save errors without reporting success and permits retry', async () => {
    save.mockRejectedValueOnce(new Error('Disk full')).mockResolvedValueOnce(undefined);
    const buildThreadPack = vi.fn().mockResolvedValue('{}');
    render(
      <DebugBundleProvider value={{ buildBundle: vi.fn(), buildThreadPack }}>
        <ThreadDebugPackButton />
      </DebugBundleProvider>
    );
    fireEvent.click(screen.getByText('Debug pack'));
    fireEvent.click(screen.getByRole('button', { name: 'Download debug pack' }));
    expect(await screen.findByText('Download failed: Disk full')).toBeTruthy();
    expect(screen.queryByText('Debug pack saved. Review before sharing.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download debug pack' }));
    expect(await screen.findByText('Debug pack saved. Review before sharing.')).toBeTruthy();
    expect(buildThreadPack).toHaveBeenCalledTimes(2);
  });
  it('downloads a fresh pack without a failed message or message runtime', async () => {
    const buildThreadPack = vi.fn().mockResolvedValue('{"messages":[]}');
    render(
      <DebugBundleProvider value={{ buildBundle: vi.fn(), buildThreadPack }}>
        <ThreadDebugPackButton />
      </DebugBundleProvider>
    );
    fireEvent.click(screen.getByText('Debug pack'));
    fireEvent.click(screen.getByRole('button', { name: 'Download debug pack' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(buildThreadPack).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].blob.type).toBe('application/json;charset=utf-8');
  });

  it('reports collection failure and never saves a partial pack', async () => {
    render(
      <DebugBundleProvider
        value={{
          buildBundle: vi.fn(),
          buildThreadPack: vi.fn().mockRejectedValue(new Error('Database unavailable')),
        }}
      >
        <ThreadDebugPackButton />
      </DebugBundleProvider>
    );
    fireEvent.click(screen.getByText('Debug pack'));
    fireEvent.click(screen.getByRole('button', { name: 'Download debug pack' }));
    expect(await screen.findByText('Download failed: Database unavailable')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('omits the action without a thread export capability', () => {
    render(<ThreadDebugPackButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
