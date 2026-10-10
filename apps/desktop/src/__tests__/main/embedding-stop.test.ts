import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  applicationDomainCapture,
  getDatabaseMock,
  installMainBootFixture,
  nativePrepareForPause,
  nativeReconfigureForReset,
  publicEmbeddingStop,
} from './boot-order-fixture';

describe('Main public embedding Stop', () => {
  installMainBootFixture();
  it.each(['none', 'native', 'host', 'both'] as const)(
    'starts public Stop after saved Pause admission, before its FIFO physical join; failure=%s',
    async (failure) => {
      getDatabaseMock.mockResolvedValue({});
      const physical = Promise.withResolvers<void>();
      const host =
        Promise.withResolvers<import('../../embedding-host-shared').EmbeddingHostStatus>();
      const entered = Promise.withResolvers<void>();
      nativeReconfigureForReset.current = () => {
        entered.resolve();
        return physical.promise;
      };
      const { EmbeddingHostManager } = await import('../../embedding-host-manager');
      const stop = vi.spyOn(EmbeddingHostManager.prototype, 'stop').mockReturnValue(host.promise);
      onTestFinished(() => {
        stop.mockRestore();
        physical.resolve();
        host.resolve({
          active: false,
          lastError: null,
          runtimeId: 'owned',
          runtimeKind: 'embedding-host',
          state: 'stopped',
        });
      });
      await import('../../main');
      const { NATIVE_INDEX_SETTINGS_KEY } = await import('../../native-index-settings');
      applicationDomainCapture.options?.onStorageChanged?.(NATIVE_INDEX_SETTINGS_KEY);
      await entered.promise;
      const complete = vi.fn(async () => physical.promise);
      nativePrepareForPause.mockImplementation(async () => ({
        complete,
        physical: physical.promise,
      }));
      const publicStop = publicEmbeddingStop.current;
      if (!publicStop) {
        throw new Error('Main did not supply public embedding Stop');
      }
      let settled = false;
      const stopping = publicStop().then(
        (status) => {
          settled = true;
          return status;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(complete).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      const nativeError = new Error('Independent native source failure');
      const hostError = new Error('Independent hidden host failure');
      if (failure === 'native' || failure === 'both') {
        physical.reject(nativeError);
      } else {
        physical.resolve();
      }
      if (failure === 'host' || failure === 'both') {
        host.reject(hostError);
      } else {
        host.resolve({
          active: false,
          lastError: null,
          runtimeId: 'owned',
          runtimeKind: 'embedding-host',
          state: 'stopped',
        });
      }
      const result = await stopping;
      expect(complete).toHaveBeenCalledOnce();
      if (failure === 'none') {
        expect(result).toMatchObject({ state: 'stopped' });
      } else if (failure === 'both') {
        expect(result).toMatchObject({ errors: [nativeError, hostError] });
      } else {
        expect(result).toBe(failure === 'native' ? nativeError : hostError);
      }
    }
  );

  it('returns an unpaused public Stop after its physical host join without waiting for unrelated native work', async () => {
    getDatabaseMock.mockResolvedValue({});
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    nativeReconfigureForReset.current = () => {
      entered.resolve();
      return held.promise;
    };
    const { EmbeddingHostManager } = await import('../../embedding-host-manager');
    const stop = vi.spyOn(EmbeddingHostManager.prototype, 'stop').mockResolvedValue({
      active: false,
      lastError: null,
      runtimeId: 'owned',
      runtimeKind: 'embedding-host',
      state: 'stopped',
    });
    onTestFinished(() => {
      held.resolve();
      stop.mockRestore();
    });
    await import('../../main');
    const { NATIVE_INDEX_SETTINGS_KEY } = await import('../../native-index-settings');
    applicationDomainCapture.options?.onStorageChanged?.(NATIVE_INDEX_SETTINGS_KEY);
    await entered.promise;
    const publicStop = publicEmbeddingStop.current;
    if (!publicStop) {
      throw new Error('Main did not supply public embedding Stop');
    }
    const settled = vi.fn();
    const stopping = publicStop().then(settled);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await stopping;
  });

  it('does not start raw Stop when native preparation refuses terminal admission', async () => {
    getDatabaseMock.mockResolvedValue({});
    const refusal = new Error('Terminal native admission refused');
    nativePrepareForPause.mockRejectedValue(refusal);
    const { EmbeddingHostManager } = await import('../../embedding-host-manager');
    const stop = vi.spyOn(EmbeddingHostManager.prototype, 'stop');
    onTestFinished(() => stop.mockRestore());
    await import('../../main');
    const publicStop = publicEmbeddingStop.current;
    if (!publicStop) {
      throw new Error('Main did not supply public embedding Stop');
    }
    await expect(publicStop()).rejects.toBe(refusal);
    expect(stop).not.toHaveBeenCalled();
  });
});
