// @vitest-environment jsdom
import './embedding-host-runtime-fixture';
import { type RenderResult, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { configureDesktopRendererTarget } from '../../../desktop-renderer-target';
import { EmbeddingHostManager } from '../../../embedding-host-manager';
import { assertEmbeddingHostStatus } from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  hostWindow,
  installEmbeddingHostRuntimeFixture,
  reopenEmbeddingQueueMock,
  reportStatusMock,
  storeState,
} from './embedding-host-runtime-fixture';

/** Reset destroys the hidden window, its renderer with it, and loads a fresh one. */
async function mountReplacementRenderer(view: RenderResult): Promise<void> {
  await waitFor(() => expect(hostWindow.loadURL).toHaveBeenCalledTimes(2));
  view.unmount();
  const fresh = render(<EmbeddingHostRuntime />);
  onTestFinished(() => fresh.unmount());
}

describe('Embedding host manager and renderer control ownership', () => {
  installEmbeddingHostRuntimeFixture();

  it("answers a reset with the replacement host's own startup failure", async () => {
    storeState.hasHydrated = true;
    configureDesktopRendererTarget({
      kind: 'dev-renderer',
      launchMode: 'dev-server',
      url: 'http://localhost',
    });
    const manager = new EmbeddingHostManager({ platform: 'linux' });
    onTestFinished(async () => {
      hostWindow.destroy();
      await manager.dispose();
      configureDesktopRendererTarget(null);
    });
    reportStatusMock.mockImplementation((status: unknown) =>
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
    );
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const previousRuntimeId = manager.getStatus().runtimeId;
    reopenEmbeddingQueueMock.mockRejectedValueOnce(new Error('Replacement worker failed'));
    const resetting = manager.reset();
    expect(hostWindow.destroy).toHaveBeenCalledOnce();
    await mountReplacementRenderer(view);
    const result = await resetting;
    expect(result).toMatchObject({ lastError: 'Replacement worker failed', state: 'error' });
    expect(result.runtimeId).not.toBe(previousRuntimeId);
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(2);
  });

  it('completes a successful reset under its new runtime identity', async () => {
    storeState.hasHydrated = true;
    hostWindow.destroyed = false;
    configureDesktopRendererTarget({
      kind: 'dev-renderer',
      launchMode: 'dev-server',
      url: 'http://localhost',
    });
    const manager = new EmbeddingHostManager({ platform: 'linux' });
    onTestFinished(async () => {
      hostWindow.destroy();
      await manager.dispose();
      configureDesktopRendererTarget(null);
    });
    reportStatusMock.mockImplementation((status: unknown) =>
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
    );
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    onTestFinished(() => view.unmount());
    try {
      await waitFor(() => expect(manager.getStatus().state).toBe('running'));
      const previousRuntimeId = manager.getStatus().runtimeId;
      const resetting = manager.reset();
      expect(hostWindow.destroy).toHaveBeenCalledOnce();
      await mountReplacementRenderer(view);
      const result = await resetting;
      expect(result.state).toBe('running');
      expect(result.runtimeId).not.toBe(previousRuntimeId);
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(2);
      expect(hostWindow.isDestroyed()).toBe(false);
    } finally {
      await manager.dispose();
      view.unmount();
      configureDesktopRendererTarget(null);
    }
  });
});
