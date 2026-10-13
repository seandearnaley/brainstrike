import { IndexerError, type IndexerPort, type ScopedIndexerPort } from '@brainstrike/indexer';
import { vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';

export function nativeRuntimeFixture() {
  const events: string[] = [];
  let queryTargetInstalled = false;
  let authority: NativeIndexAuthority = {
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ kind: 'workspace', rootId: 'root' }],
  };
  const unused = async (): Promise<never> => {
    throw new Error('Unused fixture operation');
  };
  // The writer's current bindings, as its ScopeAuthority holds them.
  let boundFiles: readonly {
    readonly embeddingSetId: string | null;
    readonly rootId: string | null;
  }[] = [];
  const inScope = (
    file: { readonly embeddingSetId: string | null; readonly rootId: string | null },
    scope: { readonly embeddingSetId?: string; readonly kind: string; readonly rootId?: string }
  ): boolean =>
    scope.kind === 'workspace'
      ? file.rootId === scope.rootId
      : file.embeddingSetId === scope.embeddingSetId;
  const verifyScopedManifest = vi.fn(
    async (request: {
      readonly files: readonly unknown[];
      readonly scope: {
        readonly embeddingSetId?: string;
        readonly kind: string;
        readonly rootId?: string;
      };
    }) => {
      // As the writer does: a manifest declares every file bound in its scope.
      if (
        request.files.length !== boundFiles.filter((file) => inScope(file, request.scope)).length
      ) {
        throw new IndexerError(
          'incomplete-manifest',
          'A scoped manifest must declare the complete current canonical file inventory.'
        );
      }
      return {
        authorityEpoch: 'a'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: request.scope,
        storeId: 'store',
        unexpected: [],
      };
    }
  );
  const port: IndexerPort & ScopedIndexerPort = {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageBatch: unused,
    coverageScope: unused,
    destroy: unused,
    info: unused,
    prepareFile: unused,
    prepareScopedFile: unused,
    readScopedFilePage: unused,
    removeFile: unused,
    removeScopedFile: unused,
    replaceFileBindings: vi.fn(async (bindings: unknown) => {
      boundFiles = bindings as typeof boundFiles;
      events.push('bindings-replace');
    }),
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest:
      verifyScopedManifest as unknown as ScopedIndexerPort['verifyScopedManifest'],
  };
  const closeWriter = vi.fn(async () => {
    events.push('writer-close');
  });
  const closeQueries = vi.fn(async () => {
    queryTargetInstalled = false;
    events.push('readers-close');
  });
  const closeProfile = vi.fn(async () => {
    events.push('profile-close');
  });
  const profileAttachment = { closed: Promise.withResolvers<void>().promise };
  const acquireProfile = vi.fn(async () => {
    events.push('profile-acquire');
    return profileAttachment;
  });
  const createIndexOwner = vi.fn(async (opened: NativeIndexAuthority) => ({
    close: closeWriter,
    databasePath: '/owned/index.sqlite',
    start: async () => {
      boundFiles = opened.fileBindings;
      events.push('writer-start');
      return port;
    },
  }));
  const getAuthority = vi.fn(async () => authority);
  const installQueryTarget = vi.fn(() => {
    queryTargetInstalled = true;
    events.push('reader-install');
  });
  const runtime = createNativeIndexRuntime({
    closeQueries,
    createIndexOwner,
    getAuthority,
    getFileInvalidator: () => () => {},
    installQueryTarget,
    profile: createDesktopProfileRuntime(() => ({
      acquire: acquireProfile,
      close: closeProfile,
    })),
  });
  return {
    acquireProfile,
    closeProfile,
    closeQueries,
    closeWriter,
    createIndexOwner,
    events,
    getAuthority,
    installQueryTarget,
    port,
    profileAttachment,
    queryTargetInstalled: () => queryTargetInstalled,
    resetBindings: () => {
      authority = { ...authority, fileBindings: [] };
    },
    runtime,
    setBindings: () => {
      authority = {
        ...authority,
        fileBindings: [
          {
            embeddingSetId: null,
            fileId: 'file',
            profile: null,
            relativePath: 'file.txt',
            rootId: 'root',
            sourcePath: '/file.txt',
          },
        ],
      };
    },
    verifyScopedManifest,
  };
}
