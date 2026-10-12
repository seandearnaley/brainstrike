import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import type { NativeCanonicalCatalogRecord } from './native-canonical-catalog';
import type { createNativeCanonicalPublication } from './native-canonical-publication';
import {
  NATIVE_INDEX_SETTINGS_KEY,
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
  readNativeIndexSettings,
} from './native-index-settings';
import type { NativeIndexSources } from './native-index-source-retirement';

export interface NativeIndexActivationGraph {
  readonly controller: AbortController;
  readonly generation: number;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  observedCatalogFingerprint?: string;
  observedCatalogRecords?: readonly NativeCanonicalCatalogRecord[];
  publication?: ReturnType<typeof createNativeCanonicalPublication>;
  queuedCatalogRecords?: readonly NativeCanonicalCatalogRecord[] | undefined;
  settings: NativeIndexSettings;
  sources?: NativeIndexSources | undefined;
  readonly watchFailures: Map<string, string>;
}
export interface PreparedNativeSettings {
  complete(): Promise<void>;
  readonly physical: Promise<void>;
}

export async function readTrackedNativeSettings(
  storage: Pick<ElectronStorageAdapter, 'getItem'>,
  reads: Set<Promise<NativeIndexSettings>>
): Promise<NativeIndexSettings> {
  const reading = storage.getItem(NATIVE_INDEX_SETTINGS_KEY).then(readNativeIndexSettings);
  reads.add(reading);
  try {
    return await reading;
  } finally {
    reads.delete(reading);
  }
}

export async function joinInvalidNativeSettingsRetirement(
  physical: Promise<void>,
  close: () => Promise<void>,
  error: unknown
): Promise<void> {
  try {
    await physical;
    await close();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      'Invalid native settings retained cleanup ownership.'
    );
  }
}

interface SettingsOwner<Current extends { settings: NativeIndexSettings }> {
  apply(
    current: Current,
    settings: NativeIndexSettings,
    retire: () => Promise<void>
  ): Promise<void>;
  assertAdmission(): void;
  current(): Current | undefined;
  invalidate(error: unknown): PreparedNativeSettings;
  readSettings(): Promise<NativeIndexSettings>;
  suspend(current: Current): Promise<void>;
  transition(): Promise<void>;
}

export async function reconfigureNativeSavedSettings<
  Current extends {
    settings: NativeIndexSettings;
    sources?: { controller: AbortController } | undefined;
  },
>(owner: SettingsOwner<Current> & { readonly terminalRequested: boolean }): Promise<void> {
  if (owner.terminalRequested) {
    throw new NativeAuthorityTransitionError(
      'Native owner terminal retirement has closed transition admission.'
    );
  }
  let settings: NativeIndexSettings;
  try {
    settings = await owner.readSettings();
  } catch (error) {
    owner.assertAdmission();
    return owner.invalidate(error).complete();
  }
  owner.assertAdmission();
  const current = owner.current();
  if (
    !current ||
    nativeIndexConfigurationIdentity(current.settings) !==
      nativeIndexConfigurationIdentity(settings) ||
    (settings.paused === current.settings.paused && !current.sources?.controller.signal.aborted)
  ) {
    return owner.transition();
  }
  return owner.apply(current, settings, () => owner.suspend(current));
}

/** Stateless preparation; the activation retains every graph, epoch and physical owner. */
export async function prepareNativeSavedPause<Current extends { settings: NativeIndexSettings }>(
  owner: SettingsOwner<Current> & {
    readonly active: boolean;
    assertCurrent(current: Current): void;
    readerReady(): Promise<unknown> | undefined;
  }
): Promise<PreparedNativeSettings | null> {
  owner.assertAdmission();
  if (!owner.active) {
    return null;
  }
  let settings: NativeIndexSettings;
  try {
    settings = await owner.readSettings();
  } catch (error) {
    owner.assertAdmission();
    return owner.invalidate(error);
  }
  owner.assertAdmission();
  if (!settings.paused) {
    return null;
  }
  // Read readiness precedes the first scan receipt, but startOwned has already
  // retained its actual source owner before this continuation can run.
  await owner.readerReady();
  owner.assertAdmission();
  const current = owner.current();
  if (!current) {
    throw new NativeAuthorityTransitionError('Native Pause has no retained read authority.');
  }
  owner.assertCurrent(current);
  const physical = owner.suspend(current);
  physical.catch(() => undefined);
  return {
    complete: async () => {
      owner.assertAdmission();
      owner.assertCurrent(current);
      if (
        nativeIndexConfigurationIdentity(current.settings) !==
        nativeIndexConfigurationIdentity(settings)
      ) {
        await physical;
        await owner.transition();
        return;
      }
      await owner.apply(current, settings, () => physical);
    },
    physical,
  };
}
