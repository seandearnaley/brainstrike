import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { HostMethodHandler } from './auth-connection.js';
import type { HostClientOrigin } from './ports.js';
import {
  type HostBrowserOriginAnswer,
  type HostBrowserOriginAnswers,
  HostBrowserOriginAnswersSchema,
  HostBrowserOriginSchema,
} from './protocol-permission-policy.js';
/**
 * BST-1178: the host's StateStore settings, where it alone keeps the answer a
 * person saved for each browser origin. Core saves Always allow and Don't
 * allow when a consent is answered; Settings lists and removes them.
 */
export type HostBrowserOriginStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'setSetting'
>;
const ORIGINS_KEY = 'permissions/browser-origins';
export async function readHostBrowserOrigins(
  store: HostBrowserOriginStore
): Promise<HostBrowserOriginAnswers> {
  const value = await store.getSetting(ORIGINS_KEY);
  return value === undefined
    ? {}
    : Schema.decodeUnknownSync(HostBrowserOriginAnswersSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(JSON.parse(value));
}
/** One change at a time per store: a save and a removal never drop each other's answer. */
const changes = new WeakMap<HostBrowserOriginStore, Promise<unknown>>();
function changeHostBrowserOrigins<T>(
  store: HostBrowserOriginStore,
  change: (answers: HostBrowserOriginAnswers) => {
    readonly answers: HostBrowserOriginAnswers;
    readonly result: T;
  }
): Promise<T> {
  const next = (changes.get(store) ?? Promise.resolve()).then(async () => {
    const { answers, result } = change(await readHostBrowserOrigins(store));
    if (Object.keys(answers).length === 0) {
      await store.deleteSetting(ORIGINS_KEY);
    } else {
      await store.setSetting(
        ORIGINS_KEY,
        JSON.stringify(
          Schema.decodeSync(HostBrowserOriginAnswersSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(answers)
        )
      );
    }
    return result;
  });
  // A failed change is its caller's; the next one still runs.
  changes.set(
    store,
    next.catch(() => undefined)
  );
  return next;
}
export async function saveHostBrowserOrigin(
  store: HostBrowserOriginStore,
  origin: string,
  answer: HostBrowserOriginAnswer
): Promise<void> {
  const saved = Schema.decodeSync(HostBrowserOriginSchema)(origin);
  await changeHostBrowserOrigins(store, (answers) => ({
    answers: { ...answers, [saved]: answer },
    result: undefined,
  }));
}
export function removeHostBrowserOrigin(
  store: HostBrowserOriginStore,
  origin: string
): Promise<boolean> {
  return changeHostBrowserOrigins(store, (answers) => {
    const { [origin]: removed, ...rest } = answers;
    return { answers: rest, result: removed !== undefined };
  });
}
/**
 * The saved origin answers on one authenticated connection. Only the desktop's
 * private client reaches them, as with the permission policy they belong to.
 */
export function bindHostBrowserOriginMethods(
  handle: HostMethodHandler,
  store: HostBrowserOriginStore,
  origin: HostClientOrigin
): void {
  const owner = (): HostBrowserOriginStore => {
    if (origin !== 'desktop-ui') {
      throw new Error("Saved browser origins are available only to the desktop's private client");
    }
    return store;
  };
  handle('permissions/origins/read', async () => ({
    origins: await readHostBrowserOrigins(owner()),
  }));
  handle('permissions/origins/remove', async (params) => ({
    removed: await removeHostBrowserOrigin(owner(), params.origin),
  }));
}
/** What the model reads when a person doesn't allow an origin: final, and where it changes. */
export function browserOriginDeniedReason(origin: string): string {
  return `The user doesn't allow opening ${origin}. Don't retry it; they can change this in Settings → Permissions.`;
}
