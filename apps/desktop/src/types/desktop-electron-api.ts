import type { ContentClearCapability, WorktreeResetOutcome } from '@brainstrike/types';

interface DesktopFactoryResetBridge {
  resetLocal: () => Promise<{
    managedWorktrees?: WorktreeResetOutcome;
    message?: string;
    success: boolean;
  }>;
  /** ADR-0034: the last Factory Reset's managed worktrees, once, for the replacement window. */
  takeWorktreeOutcome: () => Promise<WorktreeResetOutcome | null>;
  readonly unavailableReason: string | undefined;
}

export interface VisibleDesktopElectronApi {
  content: ContentClearCapability;
  factoryReset: DesktopFactoryResetBridge;
  getUserDataPath: () => Promise<string>;
}

type ExactKeyList<Shape, Keys extends readonly (keyof Shape)[]> =
  Exclude<keyof Shape, Keys[number]> extends never ? Keys : never;

function defineExactKeys<Shape>() {
  return <const Keys extends readonly (keyof Shape)[]>(keys: ExactKeyList<Shape, Keys>) => keys;
}

const VISIBLE_ELECTRON_API_KEYS = defineExactKeys<VisibleDesktopElectronApi>()([
  'content',
  'factoryReset',
  'getUserDataPath',
]);
const FACTORY_RESET_KEYS = defineExactKeys<DesktopFactoryResetBridge>()([
  'resetLocal',
  'takeWorktreeOutcome',
  'unavailableReason',
]);
function assertExactKeys(label: string, value: object, expectedKeys: readonly PropertyKey[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].map(String).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `${label} key mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`
    );
  }
}

/** Fail preload startup when the runtime bridge drifts from its exact type contract. */
export function assertDesktopElectronApiKeyParity(api: VisibleDesktopElectronApi): void {
  assertExactKeys('electronAPI', api, VISIBLE_ELECTRON_API_KEYS);
  assertExactKeys('electronAPI.factoryReset', api.factoryReset, FACTORY_RESET_KEYS);
}
