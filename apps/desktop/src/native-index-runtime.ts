import type {
  IndexerPort,
  IndexFileBinding,
  IndexScope,
  ScopedIndexerPort,
} from '@brainstrike/indexer';

type NativePort = IndexerPort & ScopedIndexerPort;

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
  resume(): Promise<void>;
  retireProfile(): Promise<void>;
  retireWorkspaceCollectionFiles(embeddingSetId: string): Promise<void>;
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
  let acknowledgedAuthority: NativeIndexAuthority | undefined;
  let acknowledgedPort: NativePort | undefined;
  let outgoingCollectionId: string | undefined;
  let outgoingPort: NativePort | undefined;
  let outgoingFiles: Map<string, IndexFileBinding> | undefined;
  let workspaceRetirement: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let closingKind: 'close' | 'destroy' | undefined;

  const acquireProfile = async (): Promise<void> => {
    if (closed) {
      throw new Error('Native index admission is closed.');
    }
    profileOwner ??= dependencies.createProfileOwner();
    profileAcquisition ??= profileOwner.acquire();
    await profileAcquisition;
    if (closed) {
      throw new Error('Native profile ownership closed during startup.');
    }
  };
  const acquire = async (): Promise<NativePort> => {
    await acquireProfile();
    const requested = retainAuthority(await dependencies.getAuthority());
    const requestedScopes = scopeIdentity(requested);
    const requestedBindings = bindingIdentity(requested);
    const assertAuthorityCurrent = async (): Promise<void> => {
      const current = retainAuthority(await dependencies.getAuthority());
      if (closed) {
        throw new Error('Native index admission closed during authority validation.');
      }
      if (
        scopeIdentity(current) !== requestedScopes ||
        bindingIdentity(current) !== requestedBindings
      ) {
        throw new Error('Native index authority changed during acquisition.');
      }
    };
    if (closed) {
      throw new Error('Native index admission closed during root authorization.');
    }
    if (port && requestedScopes === scopes && requestedBindings === bindings) {
      return port;
    }
    // Retire query snapshots before changing either membership or immutable scopes.
    await dependencies.closeQueries();
    if (closed) {
      throw new Error('Native index admission closed during reader retirement.');
    }
    await assertAuthorityCurrent();
    if (port && indexOwner && requestedScopes === scopes) {
      await port.replaceFileBindings(requested.fileBindings);
      acknowledgedAuthority = requested;
      acknowledgedPort = port;
      if (closed) {
        throw new Error('Native index admission closed during binding replacement.');
      }
      await assertAuthorityCurrent();
      bindings = requestedBindings;
      dependencies.installQueryTarget(indexOwner);
      return port;
    }
    await indexOwner?.close();
    indexOwner = undefined;
    port = undefined;
    if (closed) {
      throw new Error('Native index admission closed before writer acquisition.');
    }
    await assertAuthorityCurrent();
    const owner = await dependencies.createIndexOwner(requested);
    indexOwner = owner;
    if (closed) {
      throw new Error('Native index admission closed during writer acquisition.');
    }
    await assertAuthorityCurrent();
    const ready = await owner.start();
    acknowledgedAuthority = requested;
    acknowledgedPort = ready;
    if (closed) {
      throw new Error('Native index admission closed during writer startup.');
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
    outgoingCollectionId = embeddingSetId;
    return settleWorkspaceRetirement();
  };
  const closeIndex = (destroy = false): Promise<void> => {
    closed = true;
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
      outgoingCollectionId = undefined;
      outgoingPort = undefined;
      outgoingFiles = undefined;
    })().finally(() => {
      closing = undefined;
      closingKind = undefined;
    });
    return closing;
  };
  return {
    acquire: (): Promise<NativePort> => {
      if (closed) {
        return Promise.reject(new Error('Native index admission is closed.'));
      }
      acquisition ??= acquire().finally(() => {
        acquisition = undefined;
      });
      return acquisition;
    },
    acquireProfile,
    captureAcknowledgedAuthority: () => {
      const owner = indexOwner;
      const capturedPort = acknowledgedPort;
      if (!(owner && capturedPort && acknowledgedAuthority)) {
        throw new Error('Native writer has no acknowledged ownership to capture.');
      }
      return {
        port: capturedPort,
        readAuthority: () => {
          if (indexOwner !== owner || acknowledgedPort !== capturedPort || !acknowledgedAuthority) {
            throw new Error('Captured native writer authority has been retired or replaced.');
          }
          return retainAuthority(acknowledgedAuthority);
        },
      };
    },
    closeIndex: () => closeIndex(),
    destroyIndex: () => closeIndex(true),
    resume: async (): Promise<void> => {
      if (indexOwner || profileOwner || closing || acquisition) {
        throw new Error('Previous native ownership must retire before reset resumes.');
      }
      closed = false;
      await acquireProfile();
    },
    retireProfile: async (): Promise<void> => {
      await closeIndex();
      await profileAcquisition?.catch(() => undefined);
      await profileOwner?.close();
      profileOwner = undefined;
      profileAcquisition = undefined;
    },
    retireWorkspaceCollectionFiles,
  };
}
