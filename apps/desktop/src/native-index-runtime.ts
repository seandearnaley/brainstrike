import { NativeAuthorityTransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import { retireUnownedRows, workspaceRemoval } from '@brainstrike/canonical-ingestion';
import {
  type IndexerPort,
  type IndexFileBinding,
  type IndexScope,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';

import type { DesktopProfileRuntime } from './desktop-profile-runtime';

type NativePort = IndexerPort & ScopedIndexerPort;

/**
 * Another root's discovery can move the authority while an acquisition installs
 * it, and callers can join after its last authority read (BST-2055). Each attempt
 * installs one exact snapshot; after this many, a moved authority fails visibly.
 */
const ACQUISITION_ATTEMPTS = 10;

/** The authority moved between an acquisition's snapshot and a later check. */
class NativeAuthorityMovedError extends NativeAuthorityTransitionError {}

export interface NativeIndexAuthority {
  readonly fileBindings: readonly IndexFileBinding[];
  readonly rootIds: readonly string[];
  readonly scopes: readonly IndexScope[];
}

interface IndexOwner {
  close(): Promise<void>;
  readonly databasePath: string;
  destroy?(): Promise<void>;
  start(): Promise<NativePort>;
}
interface Dependencies<Attachment> {
  closeQueries(): Promise<void>;
  createIndexOwner(authority: NativeIndexAuthority): Promise<IndexOwner>;
  getAuthority(): Promise<NativeIndexAuthority>;
  getFileInvalidator(): ((file: IndexFileBinding) => void) | undefined;
  installQueryTarget(owner: IndexOwner): void;
  readonly profile: DesktopProfileRuntime<Attachment>;
}
export interface CapturedNativeIndexAuthority {
  readonly port: NativePort;
  /** Read only after admitted sources settle; tied to this exact retained writer owner. */
  readAuthority(): NativeIndexAuthority;
}
export interface NativeSourceIdentity {
  readonly embeddingSetId: string | null;
  readonly fileId: string;
  readonly rootId: string | null;
}
export interface NativeIndexRuntime<Attachment = unknown> {
  /**
   * The acknowledged writer once any acquisition in flight settles, without
   * changing its authority; it acquires only while nothing is acknowledged yet.
   */
  acknowledged(): Promise<NativePort>;
  acquire(): Promise<NativePort>;
  /** Borrows the retained attachment; retirement remains owned by this runtime. */
  acquireProfile(options?: { readonly indexIndependent: true }): Promise<Attachment>;
  captureAcknowledgedAuthority(): CapturedNativeIndexAuthority;
  /** Closed admission only: retire one persisted collection through the retained physical writer. */
  cleanupCollection(embeddingSetId: string): Promise<void>;
  cleanupFiles(files: readonly NativeSourceIdentity[]): Promise<void>;
  closeIndex(): Promise<void>;
  destroyIndex(): Promise<void>;
  mutateAuthority<T>(expected: NativePort, work: () => Promise<T>): Promise<T>;
  resume(signal?: AbortSignal): Promise<void>;
  /** Joins a failed acquisition's release (its host exited, port closed); false when none failed. */
  retireFailedProfile(): Promise<boolean>;
  retireProfile(reason?: unknown): Promise<void>;
  retireReads(): Promise<void>;
  withRead<T>(
    acquireRead: () => Promise<NativePort>,
    work: (captured: CapturedNativeIndexAuthority) => Promise<T>
  ): Promise<T>;
  /**
   * A scan's own read through its writer (coverage and manifest proofs). It waits
   * out a binding replacement or mutation in flight, and those join it before
   * retiring readers, so another root's bindings never close its query client
   * (BST-2055).
   */
  withWriterRead<T>(expected: NativePort, work: () => Promise<T>): Promise<T>;
}

/**
 * An authority with no scopes is legitimate: Text search with no collection
 * (the TEXT partition, BST-1988) has only its folders' scopes, so with no
 * folder there is nothing to index. A collection always contributes its scope.
 */
function retainAuthority(authority: NativeIndexAuthority): NativeIndexAuthority {
  const rootIds = [...authority.rootIds].sort();
  if (new Set(rootIds).size !== rootIds.length || rootIds.some((id) => !id.trim())) {
    throw new Error('Native index requires distinct nonblank authoritative root ids.');
  }
  return {
    fileBindings: authority.fileBindings.map((binding) => ({
      ...binding,
      profile: binding.profile === null ? null : { ...binding.profile },
    })),
    rootIds,
    scopes: authority.scopes.map((scope) => ({ ...scope })),
  };
}

function scopeIdentity(authority: NativeIndexAuthority): string {
  return JSON.stringify([
    authority.rootIds,
    authority.scopes
      .map((scope) =>
        JSON.stringify([
          scope.kind,
          scope.kind === 'workspace' ? scope.rootId : scope.embeddingSetId,
        ])
      )
      .sort(),
  ]);
}

/** The indexer's own profile identity: every field that changes vectors, pooling included. */
function profileIdentity(profile: IndexFileBinding['profile']): string | null {
  return profile === null ? null : vectorProfileHash(profile);
}

function bindingIdentity(authority: NativeIndexAuthority): string {
  return JSON.stringify(
    [...authority.fileBindings]
      .sort((first, second) => first.fileId.localeCompare(second.fileId))
      .map((binding) => [
        binding.fileId,
        binding.rootId,
        binding.relativePath,
        binding.embeddingSetId,
        binding.sourcePath,
        profileIdentity(binding.profile),
      ])
  );
}

/** Main owns this admission lifetime. Reset resumes only after releasing its deletion guard. */
export function createNativeIndexRuntime<Attachment>(
  dependencies: Dependencies<Attachment>
): NativeIndexRuntime<Attachment> {
  let indexOwner: IndexOwner | undefined;
  let scopes = '';
  let bindings = '';
  let port: NativePort | undefined;
  let acquisition: Promise<NativePort> | undefined;
  // Acquisition calls so far, and how many had arrived when the latest authority read began.
  let acquireCalls = 0;
  let observedCalls = 0;
  let queryRetirement: Promise<void> | undefined;
  let authorityMutation: Promise<unknown> | undefined;
  // A binding replacement or mutation, from joining reads until it settles.
  let bindingChange: Promise<void> | undefined;
  const reads = new Set<Promise<void>>();
  let readsClosed = false;
  let acknowledgedAuthority: NativeIndexAuthority | undefined;
  let acknowledgedPort: NativePort | undefined;
  let bindingRemovalPending = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let closingKind: 'close' | 'destroy' | undefined;
  let cleanup: Promise<void> | undefined;

  const acquireProfile = async (
    options?: {
      readonly indexIndependent: true;
    },
    signal?: AbortSignal
  ): Promise<Attachment> => {
    // BST-1977: ordinary New Thread was rejected on a fresh "Setup required"
    // profile. Root admission does not reopen a closed scan/index authority.
    if (closed && !options?.indexIndependent) {
      throw new NativeAuthorityTransitionError('Native index admission is closed.');
    }
    signal?.throwIfAborted();
    const attachment = await dependencies.profile.acquire(signal);
    signal?.throwIfAborted();
    if ((closed && !options?.indexIndependent) || dependencies.profile.isRetiring()) {
      throw new NativeAuthorityTransitionError('Native profile ownership closed during startup.');
    }
    return attachment;
  };
  const retireAbsentBindings = async (
    requested: NativeIndexAuthority,
    assertAuthorityCurrent: () => Promise<void>
  ): Promise<void> => {
    const writer = port;
    if (!(writer && acknowledgedAuthority) || acknowledgedPort !== writer) {
      throw new Error('Binding retirement has no original acknowledged writer authority.');
    }
    const retainedIds = new Set(requested.fileBindings.map((file) => file.fileId));
    for (const file of acknowledgedAuthority.fileBindings) {
      if (retainedIds.has(file.fileId)) {
        continue;
      }
      await assertAuthorityCurrent();
      const invalidateFile = dependencies.getFileInvalidator();
      if (!invalidateFile) {
        throw new Error('Native binding retirement has no canonical publication owner.');
      }
      bindingRemovalPending = true;
      invalidateFile(file);
      if (file.rootId === null && file.embeddingSetId === null) {
        throw new Error('Deleted canonical binding has no original removal scope.');
      }
      await writer.removeScopedFile({
        fileId: file.fileId,
        scope:
          file.rootId === null
            ? { embeddingSetId: file.embeddingSetId, kind: 'collection' }
            : workspaceRemoval(file).scope,
      });
      await assertAuthorityCurrent();
    }
  };
  const joinReads = async (): Promise<void> => {
    await Promise.all([...reads]);
  };
  const closeQueries = (): Promise<void> => {
    // Query retirement invalidates cached read readiness, even when the writer is unchanged.
    bindings = '';
    queryRetirement = dependencies.closeQueries();
    return queryRetirement;
  };
  /** Holds writer reads off until the change settles; returns its release. */
  const beginBindingChange = (): (() => void) => {
    const change = Promise.withResolvers<void>();
    bindingChange = change.promise;
    return () => {
      if (bindingChange === change.promise) {
        bindingChange = undefined;
      }
      change.resolve();
    };
  };
  const acquire = async (priorMutation: Promise<unknown> | undefined): Promise<NativePort> => {
    // One change spans every attempt: a failed attempt may leave readers retired.
    let endChange: (() => void) | undefined;
    const enterChange = (): void => {
      endChange ??= beginBindingChange();
    };
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const ready = await acquireSnapshot(priorMutation, enterChange);
          // A caller that joined after the last authority read may have committed
          // records it did not see: read again for every caller (BST-2055).
          if (observedCalls === acquireCalls || attempt >= ACQUISITION_ATTEMPTS) {
            return ready;
          }
        } catch (error) {
          if (!(error instanceof NativeAuthorityMovedError) || attempt >= ACQUISITION_ATTEMPTS) {
            throw error;
          }
        }
      }
    } finally {
      endChange?.();
    }
  };
  const acquireSnapshot = async (
    priorMutation: Promise<unknown> | undefined,
    enterChange: () => void
  ): Promise<NativePort> => {
    await priorMutation;
    await queryRetirement;
    await acquireProfile();
    const readAuthority = async (): Promise<NativeIndexAuthority> => {
      // Every caller so far had committed its records before this read began.
      observedCalls = acquireCalls;
      return retainAuthority(await dependencies.getAuthority());
    };
    const requested = await readAuthority();
    const requestedScopes = scopeIdentity(requested);
    const requestedBindings = bindingIdentity(requested);
    const assertAuthorityCurrent = async (): Promise<void> => {
      const current = await readAuthority();
      if (closed) {
        throw new NativeAuthorityTransitionError(
          'Native index admission closed during authority validation.'
        );
      }
      if (
        scopeIdentity(current) !== requestedScopes ||
        bindingIdentity(current) !== requestedBindings
      ) {
        throw new NativeAuthorityMovedError('Native index authority changed during acquisition.');
      }
    };
    if (closed) {
      throw new NativeAuthorityTransitionError(
        'Native index admission closed during root authorization.'
      );
    }
    if (
      port &&
      !bindingRemovalPending &&
      requestedScopes === scopes &&
      requestedBindings === bindings
    ) {
      return port;
    }
    // Retire query snapshots before changing either membership or immutable scopes.
    enterChange();
    await joinReads();
    await closeQueries();
    if (closed) {
      throw new NativeAuthorityTransitionError(
        'Native index admission closed during reader retirement.'
      );
    }
    await assertAuthorityCurrent();
    if (port && indexOwner && requestedScopes === scopes) {
      await retireAbsentBindings(requested, assertAuthorityCurrent);
      await port.replaceFileBindings(requested.fileBindings);
      acknowledgedAuthority = requested;
      acknowledgedPort = port;
      bindingRemovalPending = false;
      if (closed) {
        throw new NativeAuthorityTransitionError(
          'Native index admission closed during binding replacement.'
        );
      }
      await assertAuthorityCurrent();
      dependencies.installQueryTarget(indexOwner);
      bindings = requestedBindings;
      return port;
    }
    await indexOwner?.close();
    indexOwner = undefined;
    port = undefined;
    if (closed) {
      throw new NativeAuthorityTransitionError(
        'Native index admission closed before writer acquisition.'
      );
    }
    await assertAuthorityCurrent();
    const owner = await dependencies.createIndexOwner(requested);
    indexOwner = owner;
    if (closed) {
      throw new NativeAuthorityTransitionError(
        'Native index admission closed during writer acquisition.'
      );
    }
    await assertAuthorityCurrent();
    const ready = await owner.start();
    await retireUnownedRows(ready, requested);
    acknowledgedAuthority = requested;
    acknowledgedPort = ready;
    if (closed) {
      throw new NativeAuthorityTransitionError(
        'Native index admission closed during writer startup.'
      );
    }
    await assertAuthorityCurrent();
    dependencies.installQueryTarget(owner);
    scopes = requestedScopes;
    bindings = requestedBindings;
    port = ready;
    return ready;
  };
  const closeIndex = (destroy = false): Promise<void> => {
    closed = true;
    readsClosed = true;
    const kind = destroy ? 'destroy' : 'close';
    if (closing && closingKind !== kind) {
      return Promise.reject(
        new Error('Native index retirement already owns a different operation.')
      );
    }
    closingKind = kind;
    // Keep failed cleanup retryable and keep its owner until it actually exits.
    closing ??= (async () => {
      await acquisition?.catch(() => undefined);
      await authorityMutation?.catch(() => undefined);
      await cleanup?.catch(() => undefined);
      await joinReads();
      await closeQueries();
      if (destroy && !indexOwner) {
        // Clear Content also owns an inactive on-disk index. Borrow the existing
        // writer with no source/query authority, then destroy through its close join.
        await acquireProfile({ indexIndependent: true });
        indexOwner = await dependencies.createIndexOwner({
          fileBindings: [],
          rootIds: [],
          scopes: [],
        });
        await indexOwner.start();
      }
      if (destroy && indexOwner) {
        if (!indexOwner.destroy) {
          throw new Error('Native index owner has no destructive reset capability.');
        }
        await indexOwner.destroy();
      } else {
        await indexOwner?.close();
      }
      indexOwner = undefined;
      port = undefined;
      scopes = '';
      bindings = '';
      acknowledgedAuthority = undefined;
      acknowledgedPort = undefined;
      bindingRemovalPending = false;
      authorityMutation = undefined;
    })().finally(() => {
      closing = undefined;
      closingKind = undefined;
    });
    return closing;
  };
  const cleanupOwned = (
    requested: NativeIndexAuthority,
    selected?: ReadonlySet<string>
  ): Promise<void> => {
    if (!(closed && readsClosed) || closing || cleanup || indexOwner) {
      return Promise.reject(
        new Error('Collection cleanup requires joined native retirement and closed admission.')
      );
    }
    // Retain this operation before yielding. Reset/terminal close joins it and the exact
    // physical owner it acquires; no query target or inference source is installed.
    cleanup = (async () => {
      await acquireProfile({ indexIndependent: true });
      const owned = await dependencies.createIndexOwner(requested);
      indexOwner = owned;
      const writer = await owned.start();
      await retireUnownedRows(writer, requested, selected);
    })().finally(() => {
      cleanup = undefined;
    });
    return cleanup;
  };
  const cleanupCollection = (embeddingSetId: string): Promise<void> => {
    if (!embeddingSetId.trim()) {
      return Promise.reject(new Error('Collection identity is required'));
    }
    return cleanupOwned({
      fileBindings: [],
      rootIds: [],
      scopes: [{ embeddingSetId, kind: 'collection' }],
    });
  };
  const cleanupFiles = (files: readonly NativeSourceIdentity[]): Promise<void> => {
    const roots = [...new Set(files.flatMap((file) => (file.rootId ? [file.rootId] : [])))];
    const collections = [
      ...new Set(
        files.flatMap((file) => (!file.rootId && file.embeddingSetId ? [file.embeddingSetId] : []))
      ),
    ];
    return cleanupOwned(
      {
        fileBindings: [],
        rootIds: roots,
        scopes: [
          ...roots.map((rootId) => ({ kind: 'workspace' as const, rootId })),
          ...collections.map((embeddingSetId) => ({ embeddingSetId, kind: 'collection' as const })),
        ],
      },
      new Set(files.map((file) => file.fileId))
    );
  };
  const acquireCurrent = (): Promise<NativePort> => {
    if (closed) {
      return Promise.reject(
        new NativeAuthorityTransitionError('Native index admission is closed.')
      );
    }
    acquireCalls += 1;
    acquisition ??= acquire(authorityMutation).finally(() => {
      acquisition = undefined;
    });
    return acquisition;
  };
  const captureAcknowledgedAuthority = (): CapturedNativeIndexAuthority => {
    const owner = indexOwner;
    const capturedPort = acknowledgedPort;
    if (!(owner && capturedPort && acknowledgedAuthority)) {
      throw new Error('Native writer has no acknowledged ownership to capture.');
    }
    return {
      port: capturedPort,
      readAuthority: () => {
        if (indexOwner !== owner || acknowledgedPort !== capturedPort || !acknowledgedAuthority) {
          throw new NativeAuthorityTransitionError(
            'Captured native writer authority has been retired or replaced.'
          );
        }
        return retainAuthority(acknowledgedAuthority);
      },
    };
  };
  return {
    acknowledged: async (): Promise<NativePort> => {
      await acquisition?.catch(() => undefined);
      return indexOwner && acknowledgedPort ? acknowledgedPort : acquireCurrent();
    },
    acquire: acquireCurrent,
    acquireProfile,
    captureAcknowledgedAuthority,
    cleanupCollection,
    cleanupFiles,
    closeIndex: () => closeIndex(),
    destroyIndex: () => closeIndex(true),
    mutateAuthority: <T>(expected: NativePort, work: () => Promise<T>): Promise<T> => {
      if (closed) {
        return Promise.reject(
          new NativeAuthorityTransitionError('Native index admission is closed.')
        );
      }
      // Capture predecessors before publishing this intent; never wait on later acquisitions.
      const priorAcquisition = acquisition;
      const priorMutation = authorityMutation;
      const operation = (async () => {
        await priorAcquisition;
        await priorMutation;
        const endChange = beginBindingChange();
        try {
          await joinReads();
          if (closed || port !== expected) {
            throw new Error('Native mutation writer was retired or replaced.');
          }
          await closeQueries();
          if (closed || port !== expected) {
            throw new Error('Native mutation writer was retired or replaced.');
          }
          return await work();
        } finally {
          endChange();
        }
      })();
      authorityMutation = operation;
      operation.then(
        () => {
          if (authorityMutation === operation) {
            authorityMutation = undefined;
          }
        },
        () => undefined
      );
      return operation;
    },
    resume: async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      if (indexOwner || dependencies.profile.isRetiring() || closing || acquisition) {
        throw new Error('Previous native ownership must retire before reset resumes.');
      }
      closed = false;
      readsClosed = false;
      await acquireProfile(undefined, signal);
    },
    retireFailedProfile: dependencies.profile.retireFailed,
    retireProfile: (reason) => dependencies.profile.retire(closeIndex(), reason),
    retireReads: async (): Promise<void> => {
      readsClosed = true;
      await joinReads();
    },
    withRead: async <T>(
      acquireRead: () => Promise<NativePort>,
      work: (captured: CapturedNativeIndexAuthority) => Promise<T>
    ): Promise<T> => {
      while (true) {
        if (closed || readsClosed) {
          throw new NativeAuthorityTransitionError('Native read admission is closed.');
        }
        const acquired = await acquireRead();
        await authorityMutation;
        if (acquisition || authorityMutation) {
          continue;
        }
        if (closed || readsClosed) {
          throw new NativeAuthorityTransitionError('Native read admission is closed.');
        }
        const captured = captureAcknowledgedAuthority();
        if (captured.port !== acquired) {
          throw new Error('Native read acquired a retired or foreign writer.');
        }
        const settled = Promise.withResolvers<void>();
        reads.add(settled.promise);
        try {
          return await work({
            port: captured.port,
            readAuthority: () => {
              if (closed || readsClosed) {
                throw new NativeAuthorityTransitionError('Native read admission is closed.');
              }
              return captured.readAuthority();
            },
          });
        } finally {
          reads.delete(settled.promise);
          settled.resolve();
        }
      }
    },
    withWriterRead: async <T>(expected: NativePort, work: () => Promise<T>): Promise<T> => {
      // Only a change retiring readers excludes a proof; an acquisition that finds
      // its bindings current retires nothing, and readers start one per poll.
      while (bindingChange) {
        await bindingChange;
      }
      if (closed || readsClosed) {
        throw new NativeAuthorityTransitionError('Native read admission is closed.');
      }
      if (port !== expected) {
        throw new NativeAuthorityTransitionError('Native writer was retired or replaced.');
      }
      const settled = Promise.withResolvers<void>();
      reads.add(settled.promise);
      try {
        return await work();
      } finally {
        reads.delete(settled.promise);
        settled.resolve();
      }
    },
  };
}
