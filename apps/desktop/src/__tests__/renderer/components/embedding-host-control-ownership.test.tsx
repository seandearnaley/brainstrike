import './embedding-host-runtime-fixture';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { configureDesktopRendererTarget } from '../../../desktop-renderer-target';
import { EmbeddingHostManager } from '../../../embedding-host-manager';
import { assertEmbeddingHostStatus } from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  hostWindow,
  installEmbeddingHostRuntimeFixture,
  reportStatusMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} from './embedding-host-runtime-fixture';

describe('Embedding host manager and renderer control ownership', () => {
  installEmbeddingHostRuntimeFixture();
  it('delivers a failed reset drain through the actual manager without awaiting its timeout', async () => {
    storeState.hasHydrated = true;
    hostWindow.destroyed = false;
    configureDesktopRendererTarget({
      kind: 'dev-renderer',
      launchMode: 'dev-server',
      url: 'http://localhost',
    });
    const manager = new EmbeddingHostManager({ platform: 'linux' });
    reportStatusMock.mockImplementation((status: unknown) =>
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
    );
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    const previousRuntimeId = manager.getStatus().runtimeId;
    let failDrain: ((error: Error) => void) | undefined;
    stopMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failDrain = reject;
        })
    );
    let result: Awaited<ReturnType<typeof manager.reset>> | undefined;
    const reset = manager.reset().then((status) => {
      result = status;
    });
    try {
      await waitFor(() => expect(failDrain).toBeDefined());
      manager.acceptStatusReport(hostWindow.webContents.id, {
        active: false,
        commandId: 'unrelated-reset',
        lastError: 'Stale failure',
        runtimeId: previousRuntimeId,
        runtimeKind: 'embedding-host',
        state: 'error',
      });
      expect(manager.getStatus().state).toBe('starting');
      expect(result).toBeUndefined();
      failDrain?.(new Error('Original worker drain failed'));
      await waitFor(() =>
        expect(result).toMatchObject({
          lastError: 'Original worker drain failed',
          runtimeId: previousRuntimeId,
          state: 'error',
        })
      );
      await reset;
      expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
      expect(hostWindow.isDestroyed()).toBe(true);
    } finally {
      hostWindow.destroy();
      await manager.dispose();
      await reset;
      view.unmount();
      configureDesktopRendererTarget(null);
    }
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
    reportStatusMock.mockImplementation((status: unknown) =>
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
    );
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    try {
      await waitFor(() => expect(manager.getStatus().state).toBe('running'));
      const previousRuntimeId = manager.getStatus().runtimeId;
      const result = await manager.reset();
      expect(result.state).toBe('running');
      expect(result.runtimeId).not.toBe(previousRuntimeId);
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2);
      expect(hostWindow.isDestroyed()).toBe(false);
    } finally {
      await manager.dispose();
      view.unmount();
      configureDesktopRendererTarget(null);
    }
  });

  it('rejects the actual manager Stop when its registered host window closes during drain', async () => {
    storeState.hasHydrated = true;
    hostWindow.destroyed = false;
    configureDesktopRendererTarget({
      kind: 'dev-renderer',
      launchMode: 'dev-server',
      url: 'http://localhost',
    });
    const manager = new EmbeddingHostManager({ platform: 'linux' });
    reportStatusMock.mockImplementation((status: unknown) =>
      manager.acceptStatusReport(hostWindow.webContents.id, assertEmbeddingHostStatus(status))
    );
    await manager.ensureStarted({ waitForRunning: false });
    const view = render(<EmbeddingHostRuntime />);
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    let finishDrain: (() => void) | undefined;
    stopMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        })
    );
    let failure: unknown;
    const stop = manager.stop().catch((error: unknown) => {
      failure = error;
    });
    await waitFor(() => expect(finishDrain).toBeDefined());
    view.unmount();
    hostWindow.destroy();
    try {
      await waitFor(() =>
        expect(failure).toMatchObject({
          message: 'embedding-host window closed before its state transition completed.',
        })
      );
      expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
    } finally {
      finishDrain?.();
      await manager.dispose();
      await stop;
      configureDesktopRendererTarget(null);
    }
  });
});
