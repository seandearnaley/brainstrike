import './embedding-host-runtime-fixture';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { configureDesktopRendererTarget } from '../../../desktop-renderer-target';
import { EmbeddingHostManager } from '../../../embedding-host-manager';
import { assertEmbeddingHostStatus } from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  createHostWindowMock,
  currentDbRef,
  dbHandle,
  hostWindow,
  installEmbeddingHostRuntimeFixture,
  reopenEmbeddingQueueMock,
  reportStatusMock,
  retireEmbeddingQueueMock,
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
    let failDrain: ((error: Error) => void) | undefined;
    retireEmbeddingQueueMock.mockImplementationOnce(
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
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
      expect(hostWindow.isDestroyed()).toBe(true);
      view.unmount();
      await manager.ensureStarted({ waitForRunning: false });
      const freshView = render(<EmbeddingHostRuntime />);
      onTestFinished(() => freshView.unmount());
      await waitFor(() => expect(manager.getStatus().state).toBe('running'));
      expect(manager.getStatus().runtimeId).not.toBe(previousRuntimeId);
      expect(createHostWindowMock).toHaveBeenCalledTimes(2);
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(2);
      await manager.stop();
      freshView.unmount();
    } finally {
      hostWindow.destroy();
      await manager.dispose();
      await reset;
      view.unmount();
      configureDesktopRendererTarget(null);
    }
  });

  it.each(['before', 'during'] as const)(
    'settles Stop when the live renderer loses its DB %s the command',
    async (timing) => {
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
      await waitFor(() => expect(manager.getStatus().state).toBe('running'));
      let finishDrain: (() => void) | undefined;
      retireEmbeddingQueueMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDrain = resolve;
          })
      );
      const loseDatabase = async () => {
        await act(async () => {
          currentDbRef.current = null;
          view.rerender(<EmbeddingHostRuntime />);
        });
      };
      if (timing === 'before') {
        await loseDatabase();
      }
      let result: Awaited<ReturnType<typeof manager.stop>> | undefined;
      let failure: unknown;
      const stopped = manager.stop().then(
        (status) => {
          result = status;
        },
        (error: unknown) => {
          failure = error;
        }
      );
      if (timing === 'during') {
        await loseDatabase();
      }
      try {
        await waitFor(() => expect(finishDrain).toBeDefined());
        await act(async () => finishDrain?.());
        await waitFor(() => expect(result?.state).toBe('stopped'));
        expect(failure).toBeUndefined();
        await act(async () => {
          currentDbRef.current = dbHandle;
          view.rerender(<EmbeddingHostRuntime />);
        });
        expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
      } finally {
        finishDrain?.();
        hostWindow.destroy();
        await manager.dispose();
        await stopped;
        view.unmount();
        configureDesktopRendererTarget(null);
      }
    }
  );

  it('destroys the owner when a replacement worker fails during reset', async () => {
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
    const result = await manager.reset();
    expect(result).toMatchObject({ lastError: 'Replacement worker failed', state: 'error' });
    expect(result.runtimeId).not.toBe(previousRuntimeId);
    expect(hostWindow.isDestroyed()).toBe(true);
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
      const result = await manager.reset();
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

  it('rejects the actual manager Stop when its registered host window closes during drain', async () => {
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
    await waitFor(() => expect(manager.getStatus().state).toBe('running'));
    let finishDrain: (() => void) | undefined;
    retireEmbeddingQueueMock.mockImplementationOnce(
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
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
    } finally {
      finishDrain?.();
      await manager.dispose();
      await stop;
      configureDesktopRendererTarget(null);
    }
  });
});
