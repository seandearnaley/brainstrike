import { Arch } from 'electron-builder';
import { fetchPythonRuntime } from './fetch-python-runtime.mjs';

const preparingPlatforms = new Map();

/** electron-builder supplies the target, including when --linux runs on macOS. */
export default async function beforePack({ electronPlatformName: platform, arch }) {
  if (
    (platform === 'linux' && arch !== Arch.x64) ||
    (platform === 'darwin' && ![Arch.x64, Arch.arm64, Arch.universal].includes(arch))
  ) {
    throw new Error(
      `Unsupported bundled Python packaging target: ${platform}/${Arch[arch] ?? arch}.`
    );
  }
  // Universal/multi-arch builds may invoke the hook concurrently. Both Darwin
  // archives are always prepared, and one in-flight write owns each platform.
  let preparation = preparingPlatforms.get(platform);
  if (!preparation) {
    preparation = fetchPythonRuntime({ platform });
    preparingPlatforms.set(platform, preparation);
  }
  try {
    await preparation;
  } finally {
    if (preparingPlatforms.get(platform) === preparation) {
      preparingPlatforms.delete(platform);
    }
  }
}
