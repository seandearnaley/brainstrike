import { homedir } from 'node:os';
import { dirname, isAbsolute, sep } from 'node:path';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { hostAnsweringFolder, hostFolderIdentity } from './answering-folder.ts';
import type { HostMethodHandler } from './auth-connection.ts';
import {
  type HostWorkspaceTrust,
  type HostWorkspaceTrustDecision,
  HostWorkspaceTrustDecisionSchema,
} from './protocol-workspace-discovery.ts';
/**
 * The host's StateStore: its settings, where it alone records each folder's
 * workspace trust and the trusted locations, and its worktree ledger, which
 * says whose checkout a folder is.
 */
export type HostWorkspaceTrustStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'setSetting' | 'worktreeLedger'
>;
/** A workspace trust request the host refuses; its text is the reason the user reads. */
export class HostWorkspaceTrustRefusal extends BoundaryFailureError {
  constructor(message: string) {
    super(refusal({ category: 'input', code: 'workspace.trust-refused', message }));
  }
}
/**
 * ADR-0032: trust belongs to a folder's location, as in VS Code, Claude Code
 * and Codex, so a root re-pointed at another folder starts undecided and a
 * folder removed and added again keeps the person's answer. The location is the
 * folder's canonical path, the identity data roots use, so every spelling of
 * one folder (a symlink, a trailing slash, another case) shares one answer.
 */
const trustKey = (identity: string): string => `workspace.trust/${identity}`;
/**
 * The trusted locations: folders the person marked so that every folder inside
 * one reads as trusted without an ask. One setting holds them all, each by its
 * canonical path, so Settings can list them. A relative key never meets a
 * folder's, which follows `workspace.trust/` with an absolute path.
 */
const LOCATIONS_KEY = 'workspace.trust.locations';
const decodeLocations = Schema.decodeUnknownSync(Schema.Array(Schema.String));
/** True when `folder` is `container` or lies inside it; both are canonical paths. */
function isWithin(folder: string, container: string): boolean {
  return (
    folder === container ||
    folder.startsWith(container.endsWith(sep) ? container : `${container}${sep}`)
  );
}
/** The trusted locations, by canonical path, in the order they were added. */
export async function readHostTrustedLocations(
  store: HostWorkspaceTrustStore
): Promise<readonly string[]> {
  const value = await store.getSetting(LOCATIONS_KEY);
  return value === undefined ? [] : decodeLocations(JSON.parse(value));
}
/** One change at a time per store: an addition and a removal never drop each other's. */
const locationChanges = new WeakMap<HostWorkspaceTrustStore, Promise<unknown>>();
function changeHostTrustedLocations<T>(
  store: HostWorkspaceTrustStore,
  change: (locations: readonly string[]) => {
    readonly locations: readonly string[];
    readonly result: T;
  }
): Promise<T> {
  const next = (locationChanges.get(store) ?? Promise.resolve()).then(async () => {
    const { locations, result } = change(await readHostTrustedLocations(store));
    if (locations.length === 0) {
      await store.deleteSetting(LOCATIONS_KEY);
    } else {
      await store.setSetting(LOCATIONS_KEY, JSON.stringify(locations));
    }
    return result;
  });
  // A failed change is its caller's; the next one still runs.
  locationChanges.set(
    store,
    next.catch(() => undefined)
  );
  return next;
}
/**
 * The folder a trust ask may offer as a trusted location for the folder that
 * answers (`answering`, a canonical path): its parent. Undefined when that is
 * the top of the filesystem, or the person's home directory or a folder that
 * holds it, where trusting everything inside would cover every download.
 */
export function hostTrustedLocationOffer(answering: string, home: string): string | undefined {
  const parent = dirname(answering);
  if (dirname(parent) === parent) {
    return;
  }
  return isWithin(hostFolderIdentity(home) ?? home, parent) ? undefined : parent;
}
/**
 * Removes a trusted location, by the path Settings lists it under. The answers
 * given for folders stay, so a folder trusted only through the location is
 * undecided again. True when it was one.
 */
export async function removeHostTrustedLocation(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<boolean> {
  if (!isAbsolute(path)) {
    throw new HostWorkspaceTrustRefusal(
      `A trusted location is a folder's absolute path, not ${path}`
    );
  }
  // The listed path names it even when its folder is gone; another spelling names it while it exists.
  const folder = hostFolderIdentity(path);
  return await changeHostTrustedLocations(store, (locations) => {
    const kept = locations.filter((location) => location !== path && location !== folder);
    return { locations: kept, result: kept.length < locations.length };
  });
}
/** A folder and the folder whose answer it shares, each by its canonical path. */
interface AnsweringFolder {
  /**
   * The folder itself, or its repository's primary checkout when it is a
   * managed worktree (ADR-0034 decision 6). Undefined when nothing exists at
   * the path, or the repository's folder went away while this ran.
   */
  readonly answering: string | undefined;
  /** Undefined when nothing exists at the path. */
  readonly folder: string | undefined;
}
async function answeringFolder(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<AnsweringFolder> {
  if (!isAbsolute(path)) {
    throw new HostWorkspaceTrustRefusal(
      `Workspace trust needs a folder's absolute path, not ${path}`
    );
  }
  const folder = hostFolderIdentity(path);
  return {
    answering: folder === undefined ? undefined : await hostAnsweringFolder(store, folder),
    folder,
  };
}
/** The answer the folder at a path shares, and the folder it is recorded for. */
export interface HostWorkspaceTrustAnswer {
  /**
   * The canonical path of the folder that answers for this one, when it is
   * another folder: a managed worktree's repository. Undefined for a folder
   * that answers for itself.
   */
  readonly answeredBy: string | undefined;
  /** The folder's own canonical path; undefined when nothing exists there. */
  readonly folder: string | undefined;
  readonly trust: HostWorkspaceTrust;
  /**
   * The trusted location the folder is trusted through, by its canonical path.
   * Undefined when the folder's answer is one the person gave for it, or it is
   * undecided.
   */
  readonly trustedThrough: string | undefined;
}
/**
 * The trusted location that covers `answering` (a canonical path): the nearest
 * one it lies inside, unless a folder between the two is one the person kept
 * restricted. A restricted folder's contents then ask, as they did before the
 * location, instead of being trusted past the person's answer. Each folder on
 * the way is read through the folder that answers for it, so a worktree of a
 * restricted repository restricts what is in it too. The location's own answer
 * is about its own files and does not change what it covers.
 */
async function coveringLocation(
  store: HostWorkspaceTrustStore,
  answering: string
): Promise<string | undefined> {
  const location = (await readHostTrustedLocations(store))
    .filter((each) => isWithin(answering, each))
    .sort((left, right) => right.length - left.length)[0];
  if (location === undefined) {
    return;
  }
  for (
    let between = dirname(answering);
    between !== location && isWithin(between, location);
    between = dirname(between)
  ) {
    const answers = await hostAnsweringFolder(store, between);
    if (answers !== undefined && (await store.getSetting(trustKey(answers))) === 'restricted') {
      return;
    }
  }
  return location;
}
/**
 * The trust of the folder at `path`, with the folder it was read from,
 * resolved once so a listing never names one folder and shows another's
 * answer. The answer the person gave wins, restricted included. With none, the
 * folder is trusted when a trusted location covers the folder that answers for
 * it: so a managed worktree counts by its repository's place, and a symlink by
 * where it really is.
 */
export async function readHostWorkspaceTrustAnswer(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<HostWorkspaceTrustAnswer> {
  const { answering, folder } = await answeringFolder(store, path);
  // A folder that is not there loads nothing, whatever was answered for its path.
  const value = answering === undefined ? undefined : await store.getSetting(trustKey(answering));
  const answeredBy = answering === folder ? undefined : answering;
  if (value !== undefined) {
    return {
      answeredBy,
      folder,
      trust: Schema.decodeUnknownSync(HostWorkspaceTrustDecisionSchema)(value),
      trustedThrough: undefined,
    };
  }
  const trustedThrough =
    answering === undefined ? undefined : await coveringLocation(store, answering);
  return {
    answeredBy,
    folder,
    trust: trustedThrough === undefined ? 'undecided' : 'trusted',
    trustedThrough,
  };
}
/** The trust of the folder at `path`: the person's answer, a trusted location's, or undecided. */
export async function readHostWorkspaceTrust(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<HostWorkspaceTrust> {
  return (await readHostWorkspaceTrustAnswer(store, path)).trust;
}
/** What a trust answer may also record, on the person's explicit request. */
export interface HostWorkspaceTrustAlso {
  /** The person's home directory; the host's own unless a test names another. */
  readonly home?: string;
  /**
   * Also trust everything in this folder: the parent of the folder the answer
   * is recorded for, as the ask named it. Only a `trusted` answer takes one.
   */
  readonly location?: string;
}
/**
 * The canonical path to record as a trusted location for a `trusted` answer
 * given for `answering`, or the refusal the person reads. The host works out
 * the parent from its own records: the request only confirms the folder the
 * person was shown, so no client and no folder can name another.
 */
function requestedLocation(
  answering: string,
  trust: HostWorkspaceTrustDecision,
  { home = homedir(), location }: HostWorkspaceTrustAlso
): string | undefined {
  if (location === undefined) {
    return;
  }
  if (trust !== 'trusted') {
    throw new HostWorkspaceTrustRefusal(
      'A trusted location is recorded only with a trusted answer'
    );
  }
  if (!isAbsolute(location)) {
    throw new HostWorkspaceTrustRefusal(
      `A trusted location is a folder's absolute path, not ${location}`
    );
  }
  const requested = hostFolderIdentity(location);
  if (requested !== dirname(answering) || requested === answering) {
    throw new HostWorkspaceTrustRefusal(
      `${location} is not the folder that holds ${answering}, so nothing was trusted`
    );
  }
  if (hostTrustedLocationOffer(answering, home) === undefined) {
    throw new HostWorkspaceTrustRefusal(
      `${requested} is the top of the filesystem or holds your home directory, so Brainstrike does not trust everything in it; nothing was trusted`
    );
  }
  return requested;
}
/**
 * The only writer of a folder's trust and of the trusted locations: Settings,
 * the composer's chip and the CLI all call it. A location is recorded only
 * here, with a `trusted` answer and on the person's explicit request, never by
 * a read, a run or anything a folder contains.
 */
export async function writeHostWorkspaceTrust(
  store: HostWorkspaceTrustStore,
  path: string,
  trust: HostWorkspaceTrustDecision,
  also: HostWorkspaceTrustAlso = {}
): Promise<void> {
  const { answering, folder } = await answeringFolder(store, path);
  if (folder === undefined || answering === undefined) {
    // Nothing is at `path`, or its repository's folder went away while this request ran.
    throw new HostWorkspaceTrustRefusal(`${path} does not exist`);
  }
  // Decided before anything is recorded: a refused location leaves the folder as it was.
  const location = requestedLocation(answering, trust, also);
  await store.setSetting(trustKey(answering), trust);
  if (location !== undefined) {
    await changeHostTrustedLocations(store, (locations) => ({
      locations: locations.includes(location) ? locations : [...locations, location],
      result: undefined,
    }));
  }
  if (answering !== folder) {
    // This replaces what was answered for the folder alone before it was a managed worktree,
    // which would answer again once it stopped being one.
    await store.deleteSetting(trustKey(folder));
  }
}
/**
 * The roots whose repo-supplied agent configuration may load: instructions,
 * skills, slash commands and personas. A restricted or undecided root still
 * mounts; it only contributes none of these.
 */
export async function trustedHostWorkspaceRoots<
  T extends {
    readonly path: string;
  },
>(store: HostWorkspaceTrustStore, roots: readonly T[]): Promise<T[]> {
  const trusts = await Promise.all(roots.map((root) => readHostWorkspaceTrust(store, root.path)));
  return roots.filter((_root, index) => trusts[index] === 'trusted');
}
/** Trust methods on one authenticated connection, for every client origin, as hooks/trust is. */
export function bindHostWorkspaceTrustMethods(
  handle: HostMethodHandler,
  store: HostWorkspaceTrustStore
): void {
  handle('workspace/trust', async ({ location, path, trust }) => {
    await writeHostWorkspaceTrust(store, path, trust, location === undefined ? {} : { location });
    return { trust };
  });
  handle('workspace/trust/locations', async () => ({
    locations: (await readHostTrustedLocations(store)).map((path) => ({ path })),
  }));
  handle('workspace/trust/locations/remove', async ({ path }) => ({
    removed: await removeHostTrustedLocation(store, path),
  }));
  handle('workspace/trust/read', async ({ path }) => ({
    trust: await readHostWorkspaceTrust(store, path),
  }));
}
