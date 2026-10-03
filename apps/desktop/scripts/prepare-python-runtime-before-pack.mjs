import { Arch } from 'electron-builder';
import { fetchPythonRuntime } from './fetch-python-runtime.mjs';

const preparingPlatforms = new Map();

/** electron-builder supplies the target, including when --linux runs on macOS. */
export default async function beforePack({ electronPlatformName: platform, arch }) {
  if (
    (platform === 'linux' && ![Arch.x64, Arch.arm64].includes(arch)) ||
    (platform === 'darwin' && ![Arch.x64, Arch.arm64, Arch.universal].includes(arch))
  ) {
    throw new Error(
      `Unsupported bundled Python packaging target: ${platform}/${Arch[arch] ?? arch}.`
    );
  }
  // Universal/multi-arch builds may invoke the hook concurrently. Both Darwin
  // archives are always prepared; Linux stages each target independently.
  const key = platform === 'linux' ? `${platform}-${Arch[arch]}` : platform;
  let preparation = preparingPlatforms.get(key);
  if (!preparation) {
    preparation = fetchPythonRuntime(
      platform === 'linux' ? { arch: Arch[arch], platform } : { platform }
    );
    preparingPlatforms.set(key, preparation);
  }
  try {
    await preparation;
  } finally {
    if (preparingPlatforms.get(key) === preparation) {
      preparingPlatforms.delete(key);
    }
  }
}
