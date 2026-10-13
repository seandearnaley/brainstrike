import { EmbeddingDeviceLostError } from '@brainstrike/indexing-contract';

export interface GpuDeviceHandle {
  createCommandEncoder: () => { finish: () => unknown };
  readonly lost: Promise<{ readonly reason?: string; readonly message: string }>;
  readonly queue: { submit: (buffers: unknown[]) => void };
}
interface GpuAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  requestDevice: (options: {
    requiredFeatures: string[];
    requiredLimits: Record<string, number>;
  }) => Promise<GpuDeviceHandle>;
}
export interface OwnedWebGpuDevice {
  readonly device: GpuDeviceHandle;
  error: EmbeddingDeviceLostError | null;
}

/** The hidden worker owns the device; disposing ORT sessions never releases it (BST-2005). */
export function createWebGpuDeviceOwner(onLost: () => void): {
  acquire: () => Promise<OwnedWebGpuDevice>;
} {
  let current: Promise<OwnedWebGpuDevice> | null = null;
  const acquire = (): Promise<OwnedWebGpuDevice> => {
    if (current) {
      return current;
    }
    const pending = (async () => {
      const gpu = (
        globalThis.navigator as unknown as {
          gpu?: { requestAdapter: () => Promise<GpuAdapter | null> };
        }
      ).gpu;
      if (!gpu) {
        throw new Error('WebGPU is not available in this environment.');
      }
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        throw new Error('WebGPU adapter is unavailable.');
      }
      // WebIDL limits live on the prototype, so object spread drops them.
      const requiredLimits: Record<string, number> = {};
      // biome-ignore lint/suspicious/useGuardForIn: WebIDL limit properties are inherited and must be requested too.
      for (const limit in adapter.limits) {
        const value = adapter.limits[limit];
        if (typeof value === 'number') {
          requiredLimits[limit] = value;
        }
      }
      const device = await adapter.requestDevice({
        requiredFeatures: adapter.features.has('shader-f16') ? ['shader-f16'] : [],
        requiredLimits,
      });
      if (!(device && typeof device.createCommandEncoder === 'function' && device.lost)) {
        throw new Error('WebGPU adapter returned an invalid device.');
      }
      const owned: OwnedWebGpuDevice = { device, error: null };
      void device.lost.then((info) => {
        owned.error = new EmbeddingDeviceLostError(`${String(info.reason)}: ${info.message}`);
        if (current === pending) {
          current = null;
          onLost();
        }
      });
      return owned;
    })();
    current = pending;
    void pending.catch(() => {
      if (current === pending) {
        current = null;
      }
    });
    return pending;
  };
  return { acquire };
}
