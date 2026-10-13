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

type ReconfigurationOwner<Current extends { settings: NativeIndexSettings }> =
  SettingsOwner<Current> & {
    /** Its running sources started, and no startup, scan or watch failure is recorded. */
    sourcesHealthy(current: Current): boolean;
    readonly terminalRequested: boolean;
  };

interface LiveGraph {
  settings: NativeIndexSettings;
  sources?: { controller: AbortController } | undefined;
}

/** What saved settings need from the live graph; `unchanged` is the live choice, running. */
function reconfiguration<Current extends LiveGraph>(
  current: Current | undefined,
  settings: NativeIndexSettings
): 'apply' | 'transition' | 'unchanged' {
  if (
    !current ||
    nativeIndexConfigurationIdentity(current.settings) !==
      nativeIndexConfigurationIdentity(settings)
  ) {
    return 'transition';
  }
  if (settings.paused !== current.settings.paused || current.sources?.controller.signal.aborted) {
    return 'apply';
  }
  return current.sources ? 'unchanged' : 'transition';
}

/** The saved settings to reconfigure to, or the invalidation unreadable settings start. */
async function readReconfiguration<Current extends { settings: NativeIndexSettings }>(
  owner: ReconfigurationOwner<Current>
): Promise<{ readonly settings: NativeIndexSettings } | { readonly invalidated: Promise<void> }> {
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
    return { invalidated: owner.invalidate(error).complete() };
  }
  owner.assertAdmission();
  return { settings };
}

/**
 * A settings save. Saving the configuration and pause state already live, with
 * healthy running sources, changes nothing: one setup is often two saves (the
 * search mode, then the model execution), and a second full transition would
 * close reads and retire the first one's work for no change (BST-1988). After
 * a failure, the same save still transitions, so saving again retries. Committed
 * roots changing is {@link reconfigureNativeRoots}.
 */
export async function reconfigureNativeSavedSettings<Current extends LiveGraph>(
  owner: ReconfigurationOwner<Current>
): Promise<void> {
  const read = await readReconfiguration(owner);
  if ('invalidated' in read) {
    return read.invalidated;
  }
  const current = owner.current();
  const needed = reconfiguration(current, read.settings);
  if (needed === 'apply' && current) {
    return owner.apply(current, read.settings, () => owner.suspend(current));
  }
  if (needed === 'unchanged' && current && owner.sourcesHealthy(current)) {
    return;
  }
  return owner.transition();
}

/**
 * Committed roots changed. Unchanged settings still need a transition, which
 * leases every root again; a pause change or aborted sources apply as for a save.
 */
export async function reconfigureNativeRoots<Current extends LiveGraph>(
  owner: ReconfigurationOwner<Current>
): Promise<void> {
  const read = await readReconfiguration(owner);
  if ('invalidated' in read) {
    return read.invalidated;
  }
  const current = owner.current();
  if (reconfiguration(current, read.settings) === 'apply' && current) {
    return owner.apply(current, read.settings, () => owner.suspend(current));
  }
  return owner.transition();
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
