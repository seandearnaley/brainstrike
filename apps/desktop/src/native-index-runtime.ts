import type {
  IndexerPort,
  IndexFileBinding,
  IndexScope,
  ScopedIndexerPort,
} from '@brainstrike/indexer';
import { NativeAuthorityTransitionError } from './native-authority-transition';

type NativePort = IndexerPort & ScopedIndexerPort;

/** Only an already-admitted borrow can prove that its own runtime retired its authority. */
export class NativeReadAuthorityRetiredError extends Error {
  readonly code = 'native-read-authority-retired';

  constructor() {
    super('Native read admission is closed.');
    this.name = 'NativeReadAuthorityRetiredError';
  }
}

export interface NativeIndexAuthority {
  readonly fileBindings: readonly IndexFileBinding[];
  readonly rootIds: readonly string[];
  readonly scopes: readonly IndexScope[];
}

interface ProfileOwner {
  acquire(): Promise<unknown>;
  close(): Promise<void>;
}
interface IndexOwner {
  close(): Promise<void>;
  readonly databasePath: string;
  destroy?(): Promise<void>;
  start(): Promise<NativePort>;
}
interface Dependencies {
  closeQueries(): Promise<void>;
  createIndexOwner(authority: NativeIndexAuthority): Promise<IndexOwner>;
  createProfileOwner(): ProfileOwner;
  getAuthority(): Promise<NativeIndexAuthority>;
  getFileInvalidator(): ((file: IndexFileBinding) => void) | undefined;
  installQueryTarget(owner: IndexOwner): void;
}
export interface CapturedNativeIndexAuthority {
  readonly port: NativePort;
  /** Read only after admitted sources settle; tied to this exact retained writer owner. */
  readAuthority(): NativeIndexAuthority;
}
export interface NativeIndexRuntime {
  acquire(): Promise<NativePort>;
  acquireProfile(): Promise<void>;
  captureAcknowledgedAuthority(): CapturedNativeIndexAuthority;
  closeIndex(): Promise<void>;
  destroyIndex(): Promise<void>;
  mutateAuthority<T>(expected: NativePort, work: () => Promise<T>): Promise<T>;
  resume(): Promise<void>;
  retireProfile(): Promise<void>;
  retireReads(): Promise<void>;
  retireWorkspaceCollectionFiles(embeddingSetId: string): Promise<void>;
  withRead<T>(
    acquireRead: () => Promise<NativePort>,
    work: (captured: CapturedNativeIndexAuthority) => Promise<T>
  ): Promise<T>;
}

function retainAuthority(authority: NativeIndexAuthority): NativeIndexAuthority {
  const rootIds = [...authority.rootIds].sort();
  if (new Set(rootIds).size !== rootIds.length || rootIds.some((id) => !id.trim())) {
    throw new Error('Native index requires distinct nonblank authoritative root ids.');
  }
  if (authority.scopes.length === 0) {
    throw new Error(
      'No authorized desktop workspace or collection is available for native indexing.'
    );
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

function profileIdentity(profile: IndexFileBinding['profile']): readonly unknown[] | null {
  if (profile === null) {
    return null;
  }
  const identity: readonly unknown[] = [
    profile.provider,
    profile.modelId,
    profile.dimensions,
    profile.distance,
  ];
  if (profile.provider === 'local' || profile.provider === 'transformers') {
    return [...identity, profile.revision, profile.dtype, profile.tokenCap];
  }
  return identity;
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

/** Main owns this admission lifetime. Reset resumes only after releasing its deletion guard. */
export function createNativeIndexRuntime(dependencies: Dependencies): NativeIndexRuntime {
  let profileOwner: ProfileOwner | undefined;
  let profileAcquisition: Promise<unknown> | undefined;
  let indexOwner: IndexOwner | undefined;
  let scopes = '';
  let bindings = '';
  let port: NativePort | undefined;
  let acquisition: Promise<NativePort> | undefined;
  let authorityMutation: Promise<unknown> | undefined;
  const reads = new Set<Promise<void>>();
  let readsClosed = false;
  let acknowledgedAuthority: NativeIndexAuthority | undefined;
  let acknowledgedPort: NativePort | undefined;
  let bindingRemovalPending = false;
  let outgoingCollectionId: string | undefined;
  let outgoingPort: NativePort | undefined;
  let outgoingFiles: Map<string, IndexFileBinding> | undefined;
  let workspaceRetirement: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let closingKind: 'close' | 'destroy' | undefined;

  const acquireProfile = async (): Promise<void> => {
    if (closed) {
      throw new NativeAuthorityTransitionError('Native index admission is closed.');
    }
    profileOwner ??= dependencies.createProfileOwner();
    profileAcquisition ??= profileOwner.acquire();
    await profileAcquisition;
    if (closed) {
      throw new NativeAuthorityTransitionError('Native profile ownership closed during startup.');
    }
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
  const acquire = async (priorMutation: Promise<unknown> | undefined): Promise<NativePort> => {
    await priorMutation;
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
    await dependencies.closeQueries();
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
      bindings = requestedBindings;
      bindingRemovalPending = false;
      if (closed) {
        throw new NativeAuthorityTransitionError(
          'Native index admission closed during binding replacement.'
        );
      }
      await assertAuthorityCurrent();
      dependencies.installQueryTarget(indexOwner);
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
      await dependencies.closeQueries();
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
  const retireWorkspaceCollectionFiles = (embeddingSetId: string): Promise<void> => {
    if (closing || !embeddingSetId.trim()) {
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
      await dependencies.closeQueries();
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
        await dependencies.closeQueries();
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
    resume: async (): Promise<void> => {
      if (indexOwner || profileOwner || closing || acquisition) {
        throw new Error('Previous native ownership must retire before reset resumes.');
      }
      closed = false;
      readsClosed = false;
      await acquireProfile();
    },
    retireProfile: async (): Promise<void> => {
      await closeIndex();
      await profileAcquisition?.catch(() => undefined);
      await profileOwner?.close();
      profileOwner = undefined;
      profileAcquisition = undefined;
    },
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
