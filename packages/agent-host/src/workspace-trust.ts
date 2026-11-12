import { statSync } from 'node:fs';
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
  if (value === undefined) {
    return [];
  }
  const locations = decodeLocations(JSON.parse(value));
  if (!locations.every((location) => isAbsolute(location))) {
    // The host records canonical paths only, so this value is not one it wrote.
    throw new Error('The stored trusted locations hold a path that is not absolute');
  }
  return locations;
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
/** S_IWGRP and S_IWOTH: the folder's group, or anyone on the machine, may add entries to it. */
const OTHERS_MAY_WRITE = 0o022n;
/** A folder as the disk identifies it, whatever path spells it; undefined when none is there. */
const folderOnDisk = (folder: string) => statSync(folder, { bigint: true, throwIfNoEntry: false });
/**
 * True when only the person can put folders in the folder: they own it, and
 * neither its group nor everyone may write to it. A shared folder such as
 * `/tmp` or `/Users/Shared` fails, as a repository another user owns fails
 * git's `safe.directory`.
 *
 * A folder its group may write to fails even when that group is the person's
 * own (owner decision 2026-11-11): who is in a group cannot be told from the
 * folder. Debian, Ubuntu and Fedora make a person's own folders group-writable
 * by default, so there a folder counts only once group write is removed from
 * it, and otherwise asks as it did before locations.
 *
 * Windows reports neither an owner id nor these mode bits, so nothing is
 * checked there.
 */
function onlyThePersonAddsTo(onDisk: { mode: bigint; uid: bigint } | undefined): boolean {
  if (onDisk === undefined) {
    return false;
  }
  const person = process.getuid?.();
  return (
    person === undefined ||
    (onDisk.uid === BigInt(person) && (onDisk.mode & OTHERS_MAY_WRITE) === 0n)
  );
}
/**
 * True when `parent` is the home directory or holds it: by path, or because
 * the disk says it is the same folder as the home directory or one above it.
 * macOS shows one folder under two spellings (`/Users/...` and
 * `/System/Volumes/Data/Users/...`), and neither is a symlink to resolve.
 */
function holdsHome(parent: string, onDisk: { dev: bigint; ino: bigint }, home: string): boolean {
  const homeFolder = hostFolderIdentity(home) ?? home;
  if (isWithin(homeFolder, parent)) {
    return true;
  }
  for (let above = homeFolder; ; above = dirname(above)) {
    const each = folderOnDisk(above);
    if (each !== undefined && each.dev === onDisk.dev && each.ino === onDisk.ino) {
      return true;
    }
    if (dirname(above) === above) {
      return false;
    }
  }
}
/**
 * The folder a trust ask may offer as a trusted location for the folder that
 * answers (`answering`, a canonical path): its parent. Undefined when trusting
 * everything inside would reach past the person's own work:
 * - the top of the filesystem;
 * - the home directory or a folder that holds it, which would cover every download;
 * - a folder other people can put things in (`onlyThePersonAddsTo`).
 */
export function hostTrustedLocationOffer(answering: string, home: string): string | undefined {
  const parent = dirname(answering);
  if (dirname(parent) === parent) {
    return;
  }
  const onDisk = folderOnDisk(parent);
  if (onDisk === undefined || !onlyThePersonAddsTo(onDisk) || holdsHome(parent, onDisk, home)) {
    return;
  }
  return parent;
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
  // By the listed path alone, so a location whose folder is gone or unreadable still goes.
  return await changeHostTrustedLocations(store, (locations) => {
    const kept = locations.filter((location) => location !== path);
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
 * one it lies inside, unless a folder between the two says otherwise. Each
 * folder on the way is read through the folder that answers for it.
 * - One the person kept restricted: its contents ask, as they did before the
 *   location, instead of being trusted past the person's answer. A worktree of
 *   a restricted repository restricts what is in it too.
 * - A managed worktree: what is in it belongs to its repository, so it is
 *   covered only where that repository is. `inWorktree` is false for that one
 *   further look, which never follows a second worktree.
 * - One other people can put things in, the location and the folder itself
 *   included: what is in it may not be the person's, so it asks. Git refuses a
 *   repository on the same ground (`safe.directory`).
 * The location's own answer is about its own files and does not change what
 * it covers.
 */
async function coveringLocation(
  store: HostWorkspaceTrustStore,
  answering: string,
  inWorktree = true
): Promise<string | undefined> {
  const location = (await readHostTrustedLocations(store))
    .filter((each) => isWithin(answering, each))
    .sort((left, right) => right.length - left.length)[0];
  if (
    location === undefined ||
    !onlyThePersonAddsTo(folderOnDisk(location)) ||
    !onlyThePersonAddsTo(folderOnDisk(answering))
  ) {
    return;
  }
  for (
    let between = dirname(answering);
    between !== location && isWithin(between, location);
    between = dirname(between)
  ) {
    if (!onlyThePersonAddsTo(folderOnDisk(between))) {
      return;
    }
    const answers = await hostAnsweringFolder(store, between);
    // Undefined: the repository's folder went away while this ran, so nothing vouches for it.
    if (answers === undefined || (await store.getSetting(trustKey(answers))) === 'restricted') {
      return;
    }
    if (answers !== between) {
      return inWorktree ? await coveringLocation(store, answers, false) : undefined;
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
  // A managed worktree the person once kept restricted as a folder of its own keeps that
  // record until an answer is given through it; a location never trusts past it.
  const keptRestricted =
    folder !== undefined &&
    answering !== folder &&
    (await store.getSetting(trustKey(folder))) === 'restricted';
  const trustedThrough =
    answering === undefined || keptRestricted
      ? undefined
      : await coveringLocation(store, answering);
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
      `Brainstrike does not trust everything in ${requested}: it is the top of the filesystem, holds your home directory, or is a folder other people can write to. Nothing was trusted`
    );
  }
  return requested;
}
/**
 * The only writer of a folder's trust and of the trusted locations: Settings,
 * the composer's chip and the CLI all call it. A location is recorded only
 * here, with a `trusted` answer and on the person's explicit request, never by
 * a read, a run or anything a folder contains. The host itself calls it once
 * more, at the moment it makes a folder (ADR-0032, owner decisions
 * 2026-11-10: a folder the app makes is trusted with no question): it records
 * that new folder as `trusted`, and never a folder that already existed
 * (`scratch-folders.ts`).
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
 * Forgets the answer recorded for the folder at `path` itself, before the
 * host moves a folder it made to the Trash (ADR-0034 scratch threads), so no
 * answer outlives its folder. The answer is keyed by the folder's canonical
 * path, so it is read while the folder is there; resolves false, deleting
 * nothing, when no folder is at `path`. The trusted locations stay.
 */
export async function forgetHostWorkspaceTrust(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<boolean> {
  const { folder } = await answeringFolder(store, path);
  if (folder === undefined) {
    return false;
  }
  await store.deleteSetting(trustKey(folder));
  return true;
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
  handle('workspace/trust/read', async ({ path }) => {
    const answer = await readHostWorkspaceTrustAnswer(store, path);
    // The parent a `workspace/trust` for this folder may name, so a client shows it before asking.
    const answering = answer.answeredBy ?? answer.folder;
    const offeredLocation =
      answering === undefined ? undefined : hostTrustedLocationOffer(answering, homedir());
    return { ...(offeredLocation === undefined ? {} : { offeredLocation }), trust: answer.trust };
  });
}
