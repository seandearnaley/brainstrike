// The scoped writer's publication receipts, as canonical ingestion earns them: desktop's native index publishes
// through this owner.
import type {
  IndexerPort,
  ScopedCoverage,
  ScopedFilePlan,
  ScopedIndexerPort,
  ScopedManifestFile,
  ScopedManifestResult,
} from '@brainstrike/indexer';
import { vectorProfileHash } from '@brainstrike/indexer';
import type {
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalScanReceipt,
  CanonicalScanTicket,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
} from './ports.ts';

export interface NativeScopeReadiness {
  readonly generation: number;
  readonly mutationRevision: number;
  readonly publication?: NativeAcknowledgedPublication;
  readonly scanComplete: boolean;
  readonly scope: CanonicalSourceScope;
}

export interface NativeAcknowledgedPublication {
  readonly acknowledgedFiles: number;
  readonly authorityEpoch: string;
  readonly authorityRevision: number;
  readonly generation: number;
  readonly mutationRevision: number;
  readonly profileHash: string | null;
  readonly requestId: string;
  readonly storeId: string;
}

type PublicationWriter = Pick<IndexerPort, 'info'> &
  Pick<
    ScopedIndexerPort,
    | 'commitScopedFile'
    | 'commitScopedTextFiles'
    | 'coverageScope'
    | 'prepareScopedFile'
    | 'removeScopedFiles'
    | 'verifyScopedManifest'
  >;
interface ScanState {
  aborted: boolean;
  readonly acknowledgedFiles: Set<string>;
  finishing: Promise<CanonicalScanReceipt> | undefined;
  generation: number;
  readonly invalidatedFiles: Set<string>;
  mutationRevision: number;
  readonly pending: Set<Promise<unknown>>;
  publication: NativeAcknowledgedPublication | undefined;
  /** The ticket this scope's last finish released. */
  released: CanonicalScanTicket | undefined;
  scanComplete: boolean;
  sourceProof:
    | { readonly files: readonly ScopedManifestFile[]; readonly storeId: string }
    | undefined;
  ticket: CanonicalScanTicket | undefined;
  writeFailed: boolean;
}
/**
 * Every chunk of a scope whose complete manifest was just verified has its
 * vector. The indexer's `vectorCoverageComplete` also requires a chunk, since on
 * its own an empty scope cannot be told from one never scanned, and so is not
 * vector readiness. A verified complete manifest proves the scan, and a scope
 * whose files have no chunks (none, or only empty ones) has nothing to embed
 * (BST-2053).
 */
export function manifestVectorsComplete(coverage: ScopedCoverage): boolean {
  return (
    coverage.vectorCoverageComplete ||
    (coverage.profile !== null && coverage.counts.chunks === 0 && coverage.counts.vectors === 0)
  );
}
const scopeKey = (scope: ScopedManifestResult['scope']): string =>
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

/**
 * The existing scan-ticket predicate, scoped to canonical PG IDs and the sole native writer.
 * `onReadinessChange` hears each scan start and each change of a scope's completeness (a
 * settle, an abort, an invalidation); a scan's own file writes leave it incomplete, so they
 * are not changes.
 */
export function createNativeCanonicalPublication(
  writer: PublicationWriter,
  scopes: readonly CanonicalSourceScope[],
  onReadinessChange: () => void = () => {}
): CanonicalVectorPublicationPort & {
  invalidateFile(file: Pick<CanonicalFileIdentity, 'fileId' | 'rootId' | 'embeddingSetId'>): void;
  invalidateScope(scope: CanonicalSourceScope): void;
  getReadiness(): readonly NativeScopeReadiness[];
} {
  const states = new Map<string, ScanState>();
  const ownedScopes = scopes.map((scope) => ({ ...scope }));
  /** Each file's acknowledged plan in this lifetime, with the profile its vectors were written under. */
  const published = new Map<
    string,
    { readonly manifest: ScopedManifestFile; readonly profileHash: string | null }
  >();
  for (const scope of ownedScopes) {
    if (states.has(scopeKey(scope))) {
      throw new Error('Canonical publication scopes must be distinct.');
    }
    states.set(scopeKey(scope), {
      aborted: false,
      acknowledgedFiles: new Set(),
      finishing: undefined,
      generation: 0,
      invalidatedFiles: new Set(),
      mutationRevision: 0,
      pending: new Set(),
      publication: undefined,
      released: undefined,
      scanComplete: false,
      sourceProof: undefined,
      ticket: undefined,
      writeFailed: false,
    });
  }
  /** Set a scope's completeness; true when that changed it. */
  const complete = (state: ScanState, value: boolean): boolean => {
    const changed = state.scanComplete !== value;
    state.scanComplete = value;
    return changed;
  };
  /** Set one scope's completeness, telling the observer when that changed it. */
  const settle = (state: ScanState, value: boolean): void => {
    if (complete(state, value)) {
      onReadinessChange();
    }
  };
  const stateFor = (scope: CanonicalSourceScope): ScanState => {
    const state = states.get(scopeKey(scope));
    if (!state) {
      throw new Error('Canonical publication scope is not authorized.');
    }
    return state;
  };
  const sameTicket = (held: CanonicalScanTicket | undefined, ticket: CanonicalScanTicket) =>
    held?.storeId === ticket.storeId &&
    held.requestId === ticket.requestId &&
    held.generation === ticket.generation;
  const stateForTicket = (ticket: CanonicalScanTicket): ScanState => {
    const state = stateFor(ticket.scope);
    if (!sameTicket(state.ticket, ticket)) {
      throw new Error('Canonical publication ticket is stale or belongs to another store.');
    }
    return state;
  };
  /** One write of a batch of files: any file's failure fails the scan as write-failed. */
  const runWrite = async <T>(
    ticket: CanonicalScanTicket,
    files: readonly CanonicalFileIdentity[],
    work: (assertFilesCurrent: () => void) => Promise<T>
  ): Promise<T> => {
    const state = stateForTicket(ticket);
    if (files.some((file) => file.rootId !== ticket.scope.rootId)) {
      throw new Error('Canonical publication file differs from its ticket scope.');
    }
    if (state.aborted || state.finishing !== undefined) {
      throw new Error('Canonical publication write admission is closed.');
    }
    const assertFilesCurrent = (): void => {
      if (files.some((file) => state.invalidatedFiles.has(file.fileId))) {
        throw new Error('Canonical publication file was invalidated during this scan.');
      }
    };
    assertFilesCurrent();
    let changed = false;
    for (const file of files) {
      for (const scope of ownedScopes) {
        if (file.rootId === scope.rootId) {
          const affected = stateFor(scope);
          changed = complete(affected, false) || changed;
          affected.mutationRevision += 1;
        }
      }
    }
    if (changed) {
      onReadinessChange();
    }
    const pending = Promise.resolve().then(() => work(assertFilesCurrent));
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
    payload: Parameters<CanonicalVectorPublicationPort['prepareVectorFile']>[0]['payload']
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
  const assertPlan = (
    ticket: CanonicalScanTicket,
    file: CanonicalFileIdentity,
    plan: ScopedFilePlan,
    profileHash: string | null
  ): void => {
    const state = stateForTicket(ticket);
    if (
      plan.storeId !== ticket.storeId ||
      plan.profileHash !== profileHash ||
      !matches(file, manifest(plan)) ||
      (state.publication && state.publication.profileHash !== profileHash)
    ) {
      throw new Error(
        'Canonical publication plan differs from its store, profile or file identity.'
      );
    }
  };
  const acknowledgePlan = (ticket: CanonicalScanTicket, plan: ScopedFilePlan): void => {
    const state = stateForTicket(ticket);
    if (state.aborted || state.writeFailed || state.acknowledgedFiles.has(plan.snapshot.fileId)) {
      return;
    }
    state.acknowledgedFiles.add(plan.snapshot.fileId);
    state.publication = Object.freeze({
      acknowledgedFiles: state.acknowledgedFiles.size,
      authorityEpoch: plan.authorityEpoch,
      authorityRevision: plan.authorityRevision,
      generation: ticket.generation,
      mutationRevision: state.mutationRevision,
      profileHash: plan.profileHash,
      requestId: ticket.requestId,
      storeId: ticket.storeId,
    });
  };
  return {
    abortScan: async (ticket) => {
      // This scope's finish released exactly this ticket: its scan ended, so a retirement that
      // cancels it late has nothing to stop (BST-1955). Every other unheld ticket stays stale.
      if (sameTicket(stateFor(ticket.scope).released, ticket)) {
        return;
      }
      const state = stateForTicket(ticket);
      state.aborted = true;
      settle(state, false);
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
      state.acknowledgedFiles.clear();
      state.publication = undefined;
      state.invalidatedFiles.clear();
      state.aborted = false;
      state.writeFailed = false;
      state.scanComplete = false;
      state.sourceProof = undefined;
      onReadinessChange();
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
    commitTextFiles: ({ files, ticket }) =>
      runWrite(
        ticket,
        files.map(({ file }) => file),
        async (assertFilesCurrent) => {
          assertFilesCurrent();
          // The writer prepares and commits the whole batch in one transaction on the scan's store.
          const plans = await writer.commitScopedTextFiles({
            files: files.map(({ file, payload }) => ({
              snapshot: snapshot(file, payload),
              ...(payload.syntax === undefined ? {} : { syntax: payload.syntax }),
            })),
            storeId: ticket.storeId,
          });
          assertFilesCurrent();
          if (plans.length !== files.length) {
            throw new Error('Canonical publication plans differ from their batch.');
          }
          const acknowledged = files.map(({ file }, index) => {
            const plan = plans[index] as ScopedFilePlan;
            assertPlan(ticket, file, plan, null);
            return { file, plan };
          });
          for (const { file, plan } of acknowledged) {
            published.set(file.fileId, { manifest: manifest(plan), profileHash: plan.profileHash });
            acknowledgePlan(ticket, plan);
          }
        }
      ),
    commitVectorFile: ({ file, plan, profile, embeddings, syntax, ticket }) =>
      runWrite(ticket, [file], async (assertFileCurrent) => {
        assertFileCurrent();
        assertPlan(ticket, file, plan, vectorProfileHash(profile));
        await writer.commitScopedFile({
          embeddings,
          plan,
          profile,
          ...(syntax === undefined ? {} : { syntax }),
        });
        assertFileCurrent();
        published.set(file.fileId, { manifest: manifest(plan), profileHash: plan.profileHash });
        acknowledgePlan(ticket, plan);
      }),
    finishScan: async (request) => {
      const state = stateForTicket(request.ticket);
      if (state.finishing !== undefined) {
        return Promise.reject(new Error('Canonical scan is already finishing.'));
      }
      settle(state, false);
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
            const stored = published.get(file.fileId)?.manifest;
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
          if (result.complete) {
            state.sourceProof = { files, storeId: result.storeId };
          }
          settle(state, result.complete);
          return receipt(result.complete ? 'complete' : 'manifest-mismatch');
        })
        .finally(() => {
          state.released = state.ticket;
          state.ticket = undefined;
          state.finishing = undefined;
        });
      state.finishing = finish;
      return finish;
    },
    getReadiness: () =>
      ownedScopes.map((scope) => {
        const state = stateFor(scope);
        return {
          generation: state.generation,
          mutationRevision: state.mutationRevision,
          scanComplete: state.scanComplete,
          scope,
          ...(!(state.aborted || state.writeFailed) && state.publication
            ? { publication: state.publication }
            : {}),
        };
      }),
    invalidateFile: (file) => {
      const acknowledgedPlan = published.delete(file.fileId);
      let changed = false;
      for (const scope of ownedScopes) {
        if (scope.rootId !== file.rootId) {
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
        changed = complete(state, false) || changed;
        state.mutationRevision += 1;
        state.sourceProof = undefined;
      }
      if (changed) {
        onReadinessChange();
      }
    },
    invalidateScope: (scope) => {
      const state = stateFor(scope);
      state.mutationRevision += 1;
      state.sourceProof = undefined;
      settle(state, false);
    },
    prepareVectorFile: ({ file, payload, profile, ticket }) =>
      runWrite(ticket, [file], () =>
        writer.prepareScopedFile({ profile, snapshot: snapshot(file, payload) })
      ),
    removeFiles: ({ files, ticket }) =>
      runWrite(ticket, files, async () => {
        await writer.removeScopedFiles({
          fileIds: files.map((file) => file.fileId),
          scope: ticket.scope,
        });
        for (const file of files) {
          published.delete(file.fileId);
        }
      }),
    vectorCoverage: ({ profile, scope }) => {
      stateFor(scope);
      return writer.coverageScope({ profile, scope });
    },
    verifyManifest: async ({ files, profileHash, scope }) => {
      stateFor(scope);
      const acknowledged: ScopedManifestFile[] = [];
      const missing: CanonicalManifestFile[] = [];
      const changed: CanonicalManifestFile[] = [];
      for (const file of files) {
        const stored = published.get(file.fileId);
        if (!stored) {
          missing.push(file);
        } else if (
          !matches(file, stored.manifest) ||
          file.contentHash !== stored.manifest.contentHash ||
          (profileHash !== undefined && stored.profileHash !== profileHash)
        ) {
          changed.push(file);
        } else if (profileHash !== undefined) {
          acknowledged.push(stored.manifest);
        }
      }
      // Only an acknowledged same-lifetime canonical plan permits a stat skip, and for a VECTOR
      // scan only one whose vectors were written under its profile: the scan declares that plan in
      // its vector proof. Reopening starts with no plans, forcing reads/parsing before the full
      // native proof.
      return {
        acknowledged,
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
