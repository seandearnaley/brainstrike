import {
  NATIVE_INDEX_SETTINGS_KEY,
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
  readNativeManagedCollectionId,
  readNativeIndexSettings as readSharedIndexSettings,
  readNativeSavedPause as readSharedSavedPause,
} from '@brainstrike/canonical-ingestion';
import type {
  NativeIndexLifecycle,
  PreparedNativeIndexPause,
} from './native-index-lifecycle-owner';
import { desktopSetupRequired } from './native-index-setup-required';

export {
  NATIVE_INDEX_SETTINGS_KEY,
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
  readNativeManagedCollectionId,
};

/** The shared decoder (`@brainstrike/canonical-ingestion`), refusing as desktop's settings surface it. */
export function readNativeIndexSettings(value: string | null): NativeIndexSettings {
  return readSharedIndexSettings(value, desktopSetupRequired);
}

export function readNativeSavedPause(value: string | null): NativeIndexSettings | null {
  return readSharedSavedPause(value, desktopSetupRequired);
}

/** Read once; genuine read/parse failures still enter the existing lifecycle's
 * invalid-settings fence and physical cleanup before being reported.
 */
export async function prepareSavedNativeIndexPause(
  storage: { getItem(key: string): Promise<string | null> },
  lifecycle: Promise<Pick<NativeIndexLifecycle, 'prepareSavedPause'>>
): Promise<PreparedNativeIndexPause | null> {
  let settings: NativeIndexSettings | null;
  try {
    settings = readNativeSavedPause(await storage.getItem(NATIVE_INDEX_SETTINGS_KEY));
  } catch (error) {
    return (await lifecycle).prepareSavedPause(() => Promise.reject(error));
  }
  return settings === null
    ? null
    : (await lifecycle).prepareSavedPause(() => Promise.resolve(settings));
}
