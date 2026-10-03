import type {
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalScanReceipt,
  CanonicalScanTicket,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
} from '@brainstrike/canonical-ingestion';
import type {
  IndexerPort,
  ScopedFilePlan,
  ScopedIndexerPort,
  ScopedManifestFile,
  VectorProfile,
} from '@brainstrike/indexer';
import { vectorProfileHash } from '@brainstrike/indexer';

type PublicationWriter = Pick<IndexerPort, 'info'> &
  Pick<
    ScopedIndexerPort,
    | 'commitScopedFile'
    | 'commitScopedTextFile'
    | 'coverageScope'
    | 'prepareScopedFile'
    | 'removeScopedFile'
    | 'verifyScopedManifest'
  >;
interface ScanState {
  aborted: boolean;
  finishing: Promise<CanonicalScanReceipt> | undefined;
  generation: number;
  readonly invalidatedFiles: Set<string>;
  mutationRevision: number;
  readonly pending: Set<Promise<unknown>>;
  scanComplete: boolean;
  sourceProof:
    | { readonly files: readonly ScopedManifestFile[]; readonly storeId: string }
    | undefined;
  ticket: CanonicalScanTicket | undefined;
  writeFailed: boolean;
}
const scopeKey = (scope: CanonicalSourceScope): string =>
  JSON.stringify(
    scope.kind === 'workspace' ? [scope.kind, scope.rootId] : [scope.kind, scope.embeddingSetId]
  );
const bindingKeys = ['fileId', 'embeddingSetId', 'relativePath', 'rootId', 'sourcePath'] as const;
function matches(file: CanonicalFileIdentity, stored: ScopedManifestFile): boolean {
  return bindingKeys.every((key) => file[key] === stored[key]);
}
function manifest(plan: ScopedFilePlan): ScopedManifestFile {
  return {
    chunks: plan.chunks.map(
      ({
        chunkId,
        contentHash,
        startLine,
        endLine,
        chunkIndex,
        chunkSize,
        chunkType,
        startOffset,
        endOffset,
        tokenCount,
      }) => ({
        chunkId,
        chunkIndex,
        chunkSize,
        chunkType,
        contentHash,
        endLine,
        endOffset,
        startLine,
        startOffset,
        tokenCount,
      })
    ),
    contentHash: plan.contentHash,
    embeddingSetId: plan.snapshot.embeddingSetId,
    fileId: plan.snapshot.fileId,
    relativePath: plan.snapshot.relativePath,
    rootId: plan.snapshot.rootId,
    sourcePath: plan.snapshot.sourcePath,
  };
}

/** The existing scan-ticket predicate, scoped to canonical PG IDs and the sole native writer. */
export function createNativeCanonicalPublication(
  writer: PublicationWriter,
  scopes: readonly CanonicalSourceScope[]
): CanonicalVectorPublicationPort & {
  invalidateFile(file: Pick<CanonicalFileIdentity, 'fileId' | 'rootId' | 'embeddingSetId'>): void;
  invalidateScope(scope: CanonicalSourceScope): void;
  reverifyScope(scope: CanonicalSourceScope, profile: VectorProfile | null): Promise<boolean>;
  getReadiness(): readonly {
    readonly scope: CanonicalSourceScope;
    readonly scanComplete: boolean;
  }[];
} {
  const states = new Map<string, ScanState>();
  const ownedScopes = scopes.map((scope) => ({ ...scope }));
  const published = new Map<string, ScopedManifestFile>();
  for (const scope of ownedScopes) {
    if (states.has(scopeKey(scope))) {
      throw new Error('Canonical publication scopes must be distinct.');
    }
    states.set(scopeKey(scope), {
      aborted: false,
      finishing: undefined,
      generation: 0,
      invalidatedFiles: new Set(),
      mutationRevision: 0,
      pending: new Set(),
      scanComplete: false,
      sourceProof: undefined,
      ticket: undefined,
      writeFailed: false,
    });
  }
  const stateFor = (scope: CanonicalSourceScope): ScanState => {
    const state = states.get(scopeKey(scope));
    if (!state) {
      throw new Error('Canonical publication scope is not authorized.');
    }
    return state;
  };
  const stateForTicket = (ticket: CanonicalScanTicket): ScanState => {
    const state = stateFor(ticket.scope);
    const current = state.ticket;
    if (
      !current ||
      current.storeId !== ticket.storeId ||
      current.requestId !== ticket.requestId ||
      current.generation !== ticket.generation
    ) {
      throw new Error('Canonical publication ticket is stale or belongs to another store.');
    }
    return state;
  };
  const runWrite = async <T>(
    ticket: CanonicalScanTicket,
    file: CanonicalFileIdentity,
    work: (assertFileCurrent: () => void) => Promise<T>
  ): Promise<T> => {
    const state = stateForTicket(ticket);
    if (state.aborted || state.finishing) {
      throw new Error('Canonical publication write admission is closed.');
    }
    const assertFileCurrent = (): void => {
      if (state.invalidatedFiles.has(file.fileId)) {
        throw new Error('Canonical publication file was invalidated during this scan.');
      }
    };
    assertFileCurrent();
    for (const scope of ownedScopes) {
      if (
        scope.kind === 'workspace'
          ? file.rootId === scope.rootId
          : file.embeddingSetId === scope.embeddingSetId
      ) {
        const affected = stateFor(scope);
        affected.scanComplete = false;
        affected.mutationRevision += 1;
      }
    }
    const pending = Promise.resolve().then(() => work(assertFileCurrent));
    state.pending.add(pending);
    try {
      return await pending;
    } catch (error) {
      state.writeFailed = true;
      throw error;
    } finally {
      state.pending.delete(pending);
    }
  };
  const snapshot = (
    file: CanonicalFileIdentity,
    payload: Parameters<CanonicalVectorPublicationPort['commitTextFile']>[0]['payload']
  ) => {
    if (file.fileId !== payload.fileId) {
      throw new Error('Canonical publication payload differs from its catalog file.');
    }
    return {
      content: payload.content,
      embeddingSetId: file.embeddingSetId,
      fileId: file.fileId,
      providedChunks: payload.providedChunks,
      relativePath: file.relativePath,
      rootId: file.rootId,
      sourcePath: file.sourcePath,
    };
  };
  return {
    abortScan: async (ticket) => {
      const state = stateForTicket(ticket);
      state.aborted = true;
      state.scanComplete = false;
      await Promise.allSettled([...state.pending]);
      await state.finishing;
    },
    beginScan: async ({ requestId, scope }) => {
      const state = stateFor(scope);
      if (state.ticket || state.finishing || state.pending.size > 0) {
        throw new Error('Cannot replace a scan while its writes or finish are owned.');
      }
      if (!requestId.trim()) {
        throw new Error('Canonical scan identity is blank.');
      }
      // Reserve admission before the asynchronous store lookup.
      state.generation += 1;
      state.invalidatedFiles.clear();
      state.aborted = false;
      state.writeFailed = false;
      state.scanComplete = false;
      state.sourceProof = undefined;
      const provisional = Object.freeze({
        generation: state.generation,
        requestId,
        scope: Object.freeze({ ...scope }),
        storeId: '',
      });
      state.ticket = provisional;
      try {
        const { storeId } = await writer.info();
        state.ticket = Object.freeze({ ...provisional, storeId });
        return state.ticket;
      } catch (error) {
        state.ticket = undefined;
        throw error;
      }
    },
    commitTextFile: ({ file, payload, ticket }) =>
      runWrite(ticket, file, async (assertFileCurrent) => {
        assertFileCurrent();
        const plan = await writer.prepareScopedFile({ snapshot: snapshot(file, payload) });
        assertFileCurrent();
        await writer.commitScopedTextFile({
          plan,
          ...(payload.syntax === undefined ? {} : { syntax: payload.syntax }),
        });
        assertFileCurrent();
        published.set(file.fileId, manifest(plan));
      }),
    commitVectorFile: ({ file, plan, profile, embeddings, syntax, ticket }) =>
      runWrite(ticket, file, async (assertFileCurrent) => {
        assertFileCurrent();
        if (!matches(file, manifest(plan))) {
          throw new Error('Canonical vector plan differs from its catalog binding.');
        }
        await writer.commitScopedFile({
          embeddings,
          plan,
          profile,
          ...(syntax === undefined ? {} : { syntax }),
        });
        assertFileCurrent();
        published.set(file.fileId, manifest(plan));
      }),
    finishScan: async (request) => {
      const state = stateForTicket(request.ticket);
      if (state.finishing) {
        return Promise.reject(new Error('Canonical scan is already finishing.'));
      }
      state.scanComplete = false;
      const finish = Promise.resolve()
        .then(async (): Promise<CanonicalScanReceipt> => {
          await Promise.allSettled([...state.pending]);
          const receipt = (reason: CanonicalScanReceipt['reason']): CanonicalScanReceipt => ({
            reason,
            scanComplete: reason === 'complete',
            ticket: request.ticket,
          });
          const failure = incompleteScanReason(state, request);
          if (failure !== null) {
            return receipt(failure);
          }
          const files = request.files.map((file) => {
            const stored = published.get(file.fileId);
            if (!(stored && matches(file, stored)) || file.contentHash !== stored.contentHash) {
              throw new Error('Canonical full manifest has no matching acknowledged chunk plan.');
            }
            return stored;
          });
          const revision = state.mutationRevision;
          await Promise.allSettled([...states.values()].flatMap((other) => [...other.pending]));
          const result = await writer.verifyScopedManifest({ files, scope: request.ticket.scope });
          if (
            result.storeId !== request.ticket.storeId ||
            scopeKey(result.scope) !== scopeKey(request.ticket.scope)
          ) {
            throw new Error('Canonical native manifest differs from its scan identity.');
          }
          if (state.aborted) {
            return receipt('aborted');
          }
          if (state.mutationRevision !== revision) {
            return receipt('manifest-mismatch');
          }
          state.scanComplete = result.complete;
          if (result.complete) {
            state.sourceProof = { files, storeId: result.storeId };
          }
          return receipt(result.complete ? 'complete' : 'manifest-mismatch');
        })
        .finally(() => {
          state.ticket = undefined;
          state.finishing = undefined;
        });
      state.finishing = finish;
      return finish;
    },
    getReadiness: () =>
      ownedScopes.map((scope) => ({ scanComplete: stateFor(scope).scanComplete, scope })),
    invalidateFile: (file) => {
      const acknowledgedPlan = published.delete(file.fileId);
      for (const scope of ownedScopes) {
        if (
          scope.kind === 'workspace'
            ? scope.rootId !== file.rootId
            : scope.embeddingSetId !== file.embeddingSetId
        ) {
          continue;
        }
        const state = stateFor(scope);
        state.invalidatedFiles.add(file.fileId);
        if (
          !(
            acknowledgedPlan ||
            state.sourceProof?.files.some((proof) => proof.fileId === file.fileId)
          )
        ) {
          continue;
        }
        state.scanComplete = false;
        state.mutationRevision += 1;
        state.sourceProof = undefined;
      }
    },
    invalidateScope: (scope) => {
      const state = stateFor(scope);
      state.scanComplete = false;
      state.mutationRevision += 1;
      state.sourceProof = undefined;
    },
    prepareVectorFile: ({ file, payload, profile, ticket }) =>
      runWrite(ticket, file, () =>
        writer.prepareScopedFile({ profile, snapshot: snapshot(file, payload) })
      ),
    removeFile: ({ file, ticket }) =>
      runWrite(ticket, file, async () => {
        await writer.removeScopedFile({ fileId: file.fileId, scope: ticket.scope });
        published.delete(file.fileId);
      }),
    reverifyScope: async (scope, profile) => {
      const state = stateFor(scope);
      const proof = state.sourceProof;
      if (!proof || state.ticket || state.finishing || state.aborted || state.writeFailed) {
        return false;
      }
      state.scanComplete = false;
      const revision = state.mutationRevision;
      await Promise.allSettled([...states.values()].flatMap((other) => [...other.pending]));
      const result = await writer.verifyScopedManifest({ files: proof.files, scope });
      if (result.storeId !== proof.storeId || scopeKey(result.scope) !== scopeKey(scope)) {
        throw new Error('Reverified native manifest differs from its complete source proof.');
      }
      const covered =
        profile === null || (await reverifiedCoverage(writer, result, scope, profile));
      const current =
        state.sourceProof === proof &&
        !state.ticket &&
        !state.finishing &&
        !state.aborted &&
        !state.writeFailed &&
        state.mutationRevision === revision;
      state.scanComplete = current && result.complete && covered;
      return state.scanComplete;
    },
    vectorCoverage: ({ profile, scope }) => {
      stateFor(scope);
      return writer.coverageScope({ profile, scope });
    },
    verifyManifest: async ({ files, scope }) => {
      stateFor(scope);
      const missing: CanonicalManifestFile[] = [];
      const changed: CanonicalManifestFile[] = [];
      for (const file of files) {
        const stored = published.get(file.fileId);
        if (!stored) {
          missing.push(file);
        } else if (!matches(file, stored) || file.contentHash !== stored.contentHash) {
          changed.push(file);
        }
      }
      // Only an acknowledged same-lifetime canonical plan permits a stat skip.
      // Reopening starts with no plans, forcing reads/parsing before the full native proof.
      return {
        changed,
        complete: missing.length === 0 && changed.length === 0,
        missing,
        storeId: (await writer.info()).storeId,
        unexpected: [],
      };
    },
    verifyVectorManifest: ({ files, scope }) => {
      stateFor(scope);
      return writer.verifyScopedManifest({ files, scope });
    },
  };
}

function incompleteScanReason(
  state: ScanState,
  request: Parameters<CanonicalVectorPublicationPort['finishScan']>[0]
): CanonicalScanReceipt['reason'] | null {
  if (state.aborted || request.aborted) {
    return 'aborted';
  }
  if (request.errors.length > 0) {
    return 'scan-errors';
  }
  if (request.truncatedDirectories.length > 0) {
    return 'truncated';
  }
  if (state.writeFailed) {
    return 'write-failed';
  }
  if (!request.full) {
    return 'partial';
  }
  return null;
}

async function reverifiedCoverage(
  writer: PublicationWriter,
  manifestResult: Awaited<ReturnType<ScopedIndexerPort['verifyScopedManifest']>>,
  scope: CanonicalSourceScope,
  profile: VectorProfile
): Promise<boolean> {
  const coverage = await writer.coverageScope({ profile, scope });
  if (
    coverage.storeId !== manifestResult.storeId ||
    scopeKey(coverage.scope) !== scopeKey(scope) ||
    coverage.authorityEpoch !== manifestResult.authorityEpoch ||
    coverage.authorityRevision !== manifestResult.authorityRevision ||
    coverage.profileHash !== vectorProfileHash(profile)
  ) {
    throw new Error('Reverified native coverage changed scope, profile or authority.');
  }
  return coverage.vectorCoverageComplete;
}
