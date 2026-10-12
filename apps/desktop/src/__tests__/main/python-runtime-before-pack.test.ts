import { Arch } from 'electron-builder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import beforePack from '../../../scripts/prepare-python-runtime-before-pack.mjs';

const { fetchPythonRuntime } = vi.hoisted(() => ({ fetchPythonRuntime: vi.fn() }));
vi.mock('../../../scripts/fetch-python-runtime.mjs', () => ({ fetchPythonRuntime }));

afterEach(() => {
  vi.unstubAllGlobals();
  fetchPythonRuntime.mockReset();
});

describe('Python runtime electron-builder beforePack hook', () => {
  it('prepares Linux when --linux targets Linux from a Darwin host', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    await beforePack({ arch: Arch.x64, electronPlatformName: 'linux' });
    expect(fetchPythonRuntime).toHaveBeenCalledExactlyOnceWith({ arch: 'x64', platform: 'linux' });
  });

  it('prepares Linux arm64 rather than the cross-packaging host architecture', async () => {
    vi.stubGlobal('process', { ...process, arch: 'x64', platform: 'darwin' });
    await beforePack({ arch: Arch.arm64, electronPlatformName: 'linux' });
    expect(fetchPythonRuntime).toHaveBeenCalledExactlyOnceWith({
      arch: 'arm64',
      platform: 'linux',
    });
  });

  it.each([Arch.x64, Arch.arm64, Arch.universal])(
    'prepares both Darwin archives for architecture %s on any host',
    async (arch) => {
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      await beforePack({ arch, electronPlatformName: 'darwin' });
      expect(fetchPythonRuntime).toHaveBeenCalledExactlyOnceWith({ platform: 'darwin' });
    }
  );

  it.each([Arch.armv7l, Arch.ia32, Arch.universal])(
    'rejects unsupported Linux architecture %s before preparation',
    async (arch) => {
      await expect(beforePack({ arch, electronPlatformName: 'linux' })).rejects.toThrow(
        'Unsupported bundled Python packaging target'
      );
      expect(fetchPythonRuntime).not.toHaveBeenCalled();
    }
  );

  it('preserves Windows packaging with no Python runtime selected', async () => {
    await beforePack({ arch: Arch.x64, electronPlatformName: 'win32' });
    expect(fetchPythonRuntime).toHaveBeenCalledExactlyOnceWith({ platform: 'win32' });
  });

  it('joins concurrent Darwin architecture preparation and propagates failure to every caller', async () => {
    let fail!: (error: Error) => void;
    fetchPythonRuntime.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
    );
    const first = beforePack({ arch: Arch.x64, electronPlatformName: 'darwin' });
    const second = beforePack({ arch: Arch.arm64, electronPlatformName: 'darwin' });
    const firstFailure = expect(first).rejects.toThrow('sha256 mismatch');
    const secondFailure = expect(second).rejects.toThrow('sha256 mismatch');
    expect(fetchPythonRuntime).toHaveBeenCalledTimes(1);
    fail(new Error('sha256 mismatch'));
    await Promise.all([firstFailure, secondFailure]);
    await beforePack({ arch: Arch.universal, electronPlatformName: 'darwin' });
    expect(fetchPythonRuntime).toHaveBeenCalledTimes(2);
  });
});
