import type { NativeIndexSettings } from '@brainstrike/canonical-ingestion';
import type {
  NativeIndexLifecycle,
  PreparedNativeIndexPause,
} from './native-index-lifecycle-owner';

export {
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
} from '@brainstrike/canonical-ingestion';

/** Read once; a read failure still enters the lifecycle's invalid-settings fence and cleanup. */
export async function prepareSavedNativeIndexPause(
  read: () => Promise<NativeIndexSettings>,
  lifecycle: Promise<Pick<NativeIndexLifecycle, 'prepareSavedPause'>>
): Promise<PreparedNativeIndexPause | null> {
  let settings: NativeIndexSettings;
  try {
    settings = await read();
  } catch (error) {
    return (await lifecycle).prepareSavedPause(() => Promise.reject(error));
  }
  return settings.paused
    ? (await lifecycle).prepareSavedPause(() => Promise.resolve(settings))
    : null;
}
