import {
  NativeAuthorityTransitionError,
  NativeReadAuthorityRetiredError,
} from '@brainstrike/assistant-service/node-native-text-services';
import {
  type IndexerPort,
  type IndexFileBinding,
  type IndexScope,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';

import type { DesktopProfileRuntime } from './desktop-profile-runtime';

export { NativeReadAuthorityRetiredError } from '@brainstrike/assistant-service/node-native-text-services';

type NativePort = IndexerPort & ScopedIndexerPort;

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
export interface NativeIndexRuntime<Attachment = unknown> {
  acquire(): Promise<NativePort>;
  /** Borrows the retained attachment; retirement remains owned by this runtime. */
  acquireProfile(options?: { readonly indexIndependent: true }): Promise<Attachment>;
  captureAcknowledgedAuthority(): CapturedNativeIndexAuthority;
  closeIndex(): Promise<void>;
  destroyIndex(): Promise<void>;
  mutateAuthority<T>(expected: NativePort, work: () => Promise<T>): Promise<T>;
  resume(signal?: AbortSignal): Promise<void>;
  /** Joins a failed acquisition's release (its host exited, port closed); false when none failed. */
  retireFailedProfile(): Promise<boolean>;
  retireProfile(reason?: unknown): Promise<void>;
  retireReads(): Promise<void>;
  /** Retire one partition's workspace files: a collection, or null for the TEXT partition. */
  retireWorkspaceCollectionFiles(embeddingSetId: string | null): Promise<void>;
  withRead<T>(
    acquireRead: () => Promise<NativePort>,
    work: (captured: CapturedNativeIndexAuthority) => Promise<T>
  ): Promise<T>;
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

function workspaceRemoval(file: IndexFileBinding): {
  readonly fileId: string;
  readonly scope: Extract<IndexScope, { kind: 'workspace' }>;
} {
  if (file.rootId === null) {
    throw new Error('Outgoing file has no original workspace scope.');
  }
  return { fileId: file.fileId, scope: { kind: 'workspace', rootId: file.rootId } };
}

/**
 * An opened writer's folders hold exactly the rows its bindings own (BST-1988).
 * A workspace scope's store rows are every file under that root, whatever its
 * partition, and the writer only acts on bound files. Rows from another partition
 * or retired while no writer was open would otherwise stay unbound and keep the
 * folder's manifest incomplete. Each is bound from its own stored row (no
 * partition, so no collection scope is needed) and removed; Postgres sources stay.
 * A manifest must declare every file bound in its scope, so the stored rows are
 * listed with no binding held; no reader is installed until this returns.
 */
async function retireUnownedRows(port: NativePort, requested: NativeIndexAuthority): Promise<void> {
  const folders = requested.scopes.flatMap((scope) => (scope.kind === 'workspace' ? [scope] : []));
  if (folders.length === 0) {
    return;
  }
  const roots = new Set(folders.map((scope) => scope.rootId));
  const boundInFolders = requested.fileBindings.some(
    (file) => file.rootId !== null && roots.has(file.rootId)
  );
  if (boundInFolders) {
    await port.replaceFileBindings([]);
  }
  const owned = new Set(requested.fileBindings.map((file) => file.fileId));
  const unowned: IndexFileBinding[] = [];
  for (const scope of folders) {
    const stored = await port.verifyScopedManifest({ files: [], scope });
    for (const row of stored.unexpected) {
      if (!owned.has(row.fileId)) {
        unowned.push({
          embeddingSetId: null,
          fileId: row.fileId,
          profile: null,
          relativePath: row.relativePath,
          rootId: row.rootId,
          sourcePath: row.sourcePath,
        });
      }
    }
  }
  if (unowned.length > 0) {
    await port.replaceFileBindings([...requested.fileBindings, ...unowned]);
    for (const file of unowned) {
      await port.removeScopedFile(workspaceRemoval(file));
    }
  }
  if (boundInFolders || unowned.length > 0) {
    await port.replaceFileBindings(requested.fileBindings);
  }
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
  let queryRetirement: Promise<void> | undefined;
  let authorityMutation: Promise<unknown> | undefined;
  const reads = new Set<Promise<void>>();
  let readsClosed = false;
  let acknowledgedAuthority: NativeIndexAuthority | undefined;
  let acknowledgedPort: NativePort | undefined;
  let bindingRemovalPending = false;
  // undefined: no retirement pending; null: the TEXT partition's files (BST-1988).
  let outgoingCollectionId: string | null | undefined;
  let outgoingPort: NativePort | undefined;
  let outgoingFiles: Map<string, IndexFileBinding> | undefined;
  let workspaceRetirement: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let closingKind: 'close' | 'destroy' | undefined;

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
  const acquire = async (priorMutation: Promise<unknown> | undefined): Promise<NativePort> => {
    await priorMutation;
    await queryRetirement;
    await acquireProfile();
    const requested = retainAuthority(await dependencies.getAuthority());
    const requestedScopes = scopeIdentity(requested);
    const requestedBindings = bindingIdentity(requested);
    const assertAuthorityCurrent = async (): Promise<void> => {
      const current = retainAuthority(await dependencies.getAuthority());
      if (closed) {
        throw new NativeAuthorityTransitionError(
          'Native index admission closed during authority validation.'
        );
      }
      if (
        scopeIdentity(current) !== requestedScopes ||
        bindingIdentity(current) !== requestedBindings
      ) {
        throw new NativeAuthorityTransitionError(
          'Native index authority changed during acquisition.'
        );
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
  const settleWorkspaceRetirement = (): Promise<void> => {
    workspaceRetirement ??= (async () => {
      await acquisition?.catch(() => undefined);
      await authorityMutation?.catch(() => undefined);
      await joinReads();
      if (!outgoingFiles) {
        if (!(acknowledgedPort && acknowledgedAuthority)) {
          if (indexOwner) {
            throw new Error('Outgoing native files have no acknowledged writer authority.');
          }
          return;
        }
        outgoingPort = acknowledgedPort;
        outgoingFiles = new Map(
          acknowledgedAuthority.fileBindings
            .filter((file) => file.rootId !== null && file.embeddingSetId === outgoingCollectionId)
            .map((file) => [file.fileId, file])
        );
      }
      await closeQueries();
      const ready = outgoingPort;
      if (!ready) {
        throw new Error('Outgoing native workspace authority is unavailable.');
      }
      for (const file of outgoingFiles.values()) {
        await ready.removeScopedFile(workspaceRemoval(file));
        outgoingFiles.delete(file.fileId);
      }
    })().finally(() => {
      workspaceRetirement = undefined;
    });
    return workspaceRetirement;
  };
  const retireWorkspaceCollectionFiles = (embeddingSetId: string | null): Promise<void> => {
    if (closing || (embeddingSetId !== null && !embeddingSetId.trim())) {
      return Promise.reject(
        new Error('Native workspace retirement cannot change a closing owner.')
      );
    }
    if (outgoingCollectionId !== undefined && outgoingCollectionId !== embeddingSetId) {
      return Promise.reject(
        new Error('Original outgoing native collection retirement must settle first.')
      );
    }
    closed = true;
    readsClosed = true;
    outgoingCollectionId = embeddingSetId;
    return settleWorkspaceRetirement();
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
      await joinReads();
      if (outgoingCollectionId !== undefined) {
        await settleWorkspaceRetirement();
      }
      await closeQueries();
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
      outgoingCollectionId = undefined;
      outgoingPort = undefined;
      outgoingFiles = undefined;
      authorityMutation = undefined;
    })().finally(() => {
      closing = undefined;
      closingKind = undefined;
    });
    return closing;
  };
  const acquireCurrent = (): Promise<NativePort> => {
    if (closed) {
      return Promise.reject(
        new NativeAuthorityTransitionError('Native index admission is closed.')
      );
    }
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
    acquire: acquireCurrent,
    acquireProfile,
    captureAcknowledgedAuthority,
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
        await joinReads();
        if (closed || port !== expected) {
          throw new Error('Native mutation writer was retired or replaced.');
        }
        await closeQueries();
        if (closed || port !== expected) {
          throw new Error('Native mutation writer was retired or replaced.');
        }
        return work();
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
    retireWorkspaceCollectionFiles,
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
                throw new NativeReadAuthorityRetiredError();
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
  };
}
