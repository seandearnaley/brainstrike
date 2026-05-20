export type BuiltInLocalLlmDevice = 'webgpu';

export function isBuiltInLocalLlmDeviceAvailable(device: BuiltInLocalLlmDevice): boolean {
  switch (device) {
    case 'webgpu':
      return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }
}

export function getBestBuiltInLocalLlmDevice(): BuiltInLocalLlmDevice | null {
  return isBuiltInLocalLlmDeviceAvailable('webgpu') ? 'webgpu' : null;
}
