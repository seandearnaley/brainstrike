import { createHash } from 'node:crypto';
import type { CanonicalChunker } from '@brainstrike/chunking-worker/canonical';
import type { CanonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import {
  type ScopedCoverage,
  type ScopedFilePlan,
  type ScopedManifestFile,
  type ScopedManifestResult,
  type VectorProfile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { createLogger } from '@brainstrike/logging';
import { CanonicalOperationCancelledError } from './cancellation.ts';
import { chunkCanonicalRead } from './canonical-chunk-eligibility.ts';
import type {
  CanonicalCatalogFile,
  CanonicalCatalogPort,
  CanonicalDiscoveredSourceFile,
  CanonicalDiscoveryCompletion,
  CanonicalFileIdentity,
  CanonicalInferencePort,
  CanonicalManifestFile,
  CanonicalOperationContext,
  CanonicalPublicationPort,
  CanonicalScanReceipt,
  CanonicalScanRequest,
  CanonicalScanTicket,
  CanonicalSourceExclusion,
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
} from './ports.ts';
import { manifestVectorsComplete } from './scoped-publication.ts';
import {
  assertUniqueWorkspacePaths,
  type CanonicalPreparedRead,
  getDiscoveredSources,
  prepareDiscoveredSources,
  readCanonicalSource,
  statCacheSkip,
} from './source-preparation.ts';

/**
 * VECTOR completion reads its manifest and coverage separately, and another
 * root's binding replacement between them moves the writer's authority revision
 * (BST-2055). This many reads of the pair that all straddled a move fail.
 */
const VECTOR_PROOF_READS = 5;
const logger = createLogger('CanonicalIngestionHost');

/** An owned, physically settled scan whose source proof is incomplete. */
export class CanonicalScanIncompleteError extends Error {
  readonly receipt: CanonicalScanReceipt;

  constructor(receipt: CanonicalScanReceipt) {
    super(`Canonical scan receipt is incomplete: ${receipt.reason}.`);
    this.receipt = receipt;
    this.name = 'CanonicalScanIncompleteError';
  }
}

interface ActiveScan {
  readonly controller: AbortController;
  readonly requestId: string;
  readonly settled: Promise<void>;
}
interface VectorFileInput {
  readonly file: CanonicalFileIdentity;
  readonly payload: CanonicalIndexPayload;
}
interface PreparedVectorFile extends VectorFileInput {
  readonly embeddings: { chunkId: string; vector: readonly number[] }[];
  readonly plan: ScopedFilePlan;
}
interface DiscoveryOutcome {
  readonly completion: CanonicalDiscoveryCompletion;
  readonly excluded: readonly CanonicalSourceExclusion[];
  readonly failure: unknown;
  readonly files: readonly CanonicalManifestFile[];
}
interface CanonicalIngestionCommon {
  /** The canonical chunker: `createNodeChunker` in a Node host. */
  readonly chunker: CanonicalChunker;
  /**
   * The partition discovered workspace sources join: the workspace's collection,
   * or null for the native TEXT partition (BST-1988).
   */
  readonly managedCollectionId: string | null;
  readonly source: CanonicalSourcePort;
}
export type CanonicalIngestionDependencies = CanonicalIngestionCommon &
  (
    | {
        readonly mode?: 'TEXT';
        readonly catalog: CanonicalCatalogPort;
        readonly publication: CanonicalPublicationPort;
      }
    | {
        readonly mode: 'VECTOR';
        readonly catalog: CanonicalCatalogPort<VectorProfile>;
        readonly publication: CanonicalVectorPublicationPort;
        readonly inference: CanonicalInferencePort<VectorProfile>;
      }
  );

/** One utility-owned scan. Existing source/coalescing and receipt adapters remain the authorities. */
export class CanonicalIngestionHost {
  private active: ActiveScan | undefined;
  private closed = false;
  private cleanupFailure: unknown;
  private readonly chunk: CanonicalChunker;
  private readonly inferenceRequests = new Set<string>();

  private readonly dependencies: CanonicalIngestionDependencies;

  constructor(dependencies: CanonicalIngestionDependencies) {
    this.dependencies = dependencies;
    if (
      dependencies.mode !== undefined &&
      dependencies.mode !== 'TEXT' &&
      dependencies.mode !== 'VECTOR'
    ) {
      throw new Error('Canonical ingestion requires explicit TEXT or VECTOR admission.');
    }
    if (
      dependencies.mode === 'VECTOR' &&
      !(
        dependencies.inference &&
        typeof dependencies.inference.generate === 'function' &&
        typeof dependencies.inference.cancel === 'function' &&
        typeof dependencies.inference.join === 'function' &&
        typeof dependencies.publication.prepareVectorFile === 'function' &&
        typeof dependencies.publication.commitVectorFile === 'function' &&
        typeof dependencies.publication.verifyVectorManifest === 'function' &&
        typeof dependencies.publication.vectorCoverage === 'function'
      )
    ) {
      throw new Error(
        'Explicit VECTOR requires real inference and scoped vector publication dependencies.'
      );
    }
    if (typeof dependencies.chunker !== 'function') {
      throw new Error('Canonical ingestion requires its canonical chunker.');
    }
    this.chunk = dependencies.chunker;
  }

  async scan(request: CanonicalScanRequest): Promise<CanonicalScanReceipt> {
    if (this.closed || this.active || this.cleanupFailure) {
      throw new Error('Canonical ingestion is closed or its previous scan is still owned.');
    }
    if (
      !(
        request.requestId.trim() &&
        positiveInteger(request.batchSize) &&
        positiveInteger(request.maxFileBytes)
      )
    ) {
      throw new Error(
        'Canonical scan requires explicit identity and finite positive source bounds.'
      );
    }
    const controller = new AbortController();
    const run = Promise.resolve().then(() =>
      this.run(request, { requestId: request.requestId, signal: controller.signal })
    );
    const active: ActiveScan = {
      controller,
      requestId: request.requestId,
      settled: run.then(
        () => {},
        () => {}
      ),
    };
    this.active = active;
    try {
      return await run;
    } finally {
      if (this.active === active) {
        this.active = undefined;
      }
    }
  }

  /** Settles once the cancelled scan has ended, however it ends: the scan's caller owns that. */
  async cancel(requestId: string): Promise<void> {
    const active = this.active;
    if (!active || active.requestId !== requestId) {
      throw new Error('Canonical cancellation request is stale or unknown.');
    }
    active.controller.abort(new CanonicalOperationCancelledError('Canonical scan cancelled.'));
    await active.settled;
  }

  /** Fails only when what it owns does not close: retained inference or its source. */
  async close(): Promise<void> {
    this.closed = true;
    const errors: unknown[] = [];
    if (this.active) {
      await this.cancel(this.active.requestId);
    }
    if (this.dependencies.mode === 'VECTOR') {
      for (const requestId of this.inferenceRequests) {
        try {
          await this.dependencies.inference.cancel(requestId);
        } catch (error) {
          errors.push(error);
        }
        try {
          await this.dependencies.inference.join(requestId);
          this.inferenceRequests.delete(requestId);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    try {
      await this.dependencies.source.close();
      if (this.inferenceRequests.size === 0) {
        this.cleanupFailure = undefined;
      }
    } catch (error) {
      this.cleanupFailure = error;
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical ingestion retirement failed.');
    }
  }

  private async run(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext
  ): Promise<CanonicalScanReceipt> {
    const { publication } = this.dependencies;
    context.signal.throwIfAborted();
    const ticket = await publication.beginScan({
      requestId: request.requestId,
      scope: request.scope,
    });
    if (ticket.requestId !== request.requestId || !sameScope(ticket.scope, request.scope)) {
      throw new Error('Canonical scan ticket differs from its requested authority.');
    }
    // The ticket is the publication's, not this host's. Its finish releases it on every outcome,
    // an abort only marks it aborted, and a notice for a ticket already released refuses without
    // holding anything. So a failed abort or finish notice of a cancelled scan is that scan's
    // outcome alone, never an owned resource left open. The publication belongs to Main's index
    // generation and the scan admission to its sources generation; both are replaced with them.
    let abortFailure: unknown;
    let abortNotice: Promise<void> | undefined;
    const abort = (): void => {
      abortNotice ??= Promise.resolve()
        .then(() => publication.abortScan(ticket))
        .catch((error: unknown) => {
          abortFailure = error;
        });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) {
      abort();
    }
    const outcome = await this.discoverScan(request, context, ticket, abort);
    const { completion, files } = outcome;
    let failure = outcome.failure;
    let receipt: CanonicalScanReceipt | undefined;
    if (failure !== undefined) {
      abort();
    }
    if (abortNotice !== undefined) {
      await abortNotice;
    }
    try {
      if (this.inferenceRequests.size === 0) {
        receipt = await publication.finishScan({
          ...completion,
          aborted: context.signal.aborted,
          files,
          ticket,
        });
      }
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], 'Canonical scan completion failed.');
    }
    // A notice admitted during manifest completion must physically settle.
    if (abortNotice !== undefined) {
      await abortNotice;
    }
    context.signal.removeEventListener('abort', abort);
    if (abortFailure !== undefined) {
      throw failure === undefined
        ? abortFailure
        : new AggregateError([failure, abortFailure], 'Canonical scan cancellation failed.');
    }
    if (failure !== undefined) {
      throw failure;
    }
    context.signal.throwIfAborted();
    if (!receipt) {
      throw new Error('Canonical scan receipt is incomplete: missing.');
    }
    if (!sameTicket(receipt.ticket, ticket)) {
      throw new Error('Canonical scan receipt belongs to another generation.');
    }
    if (!receipt.scanComplete) {
      throw new CanonicalScanIncompleteError(receipt);
    }
    return outcome.excluded.length > 0 ? { ...receipt, excluded: outcome.excluded } : receipt;
  }

  private async discoverScan(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket,
    stopAdmission: () => void
  ): Promise<DiscoveryOutcome> {
    const vectorFiles: ScopedManifestFile[] = [];
    let outcome: DiscoveryOutcome;
    try {
      context.signal.throwIfAborted();
      const profile =
        this.dependencies.mode === 'VECTOR'
          ? await this.dependencies.catalog
              .resolveProfile({ scope: request.scope }, context)
              .then((resolved) => {
                assertExecutableProfile(resolved);
                return resolved;
              })
          : undefined;
      context.signal.throwIfAborted();
      outcome = await this.collectManifest(
        request,
        context,
        ticket,
        profile,
        vectorFiles,
        stopAdmission
      );
      if (profile && hasCompleteDiscovery(outcome)) {
        await this.verifyVectorCompletion(request, context, ticket, profile, vectorFiles);
      }
    } catch (error) {
      outcome = {
        completion: { errors: [errorMessage(error)], full: false, truncatedDirectories: [] },
        excluded: [],
        failure: error,
        files: [],
      };
    }
    return outcome;
  }

  private async collectManifest(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket,
    profile: VectorProfile | undefined,
    vectorFiles: ScopedManifestFile[],
    stopAdmission: () => void
  ): Promise<DiscoveryOutcome> {
    const files: CanonicalManifestFile[] = [];
    const excluded: CanonicalSourceExclusion[] = [];
    const fileIds = new Set<string>();
    const workspacePaths = new Set<string>();
    let completion: CanonicalDiscoveryCompletion = {
      errors: [],
      full: false,
      truncatedDirectories: [],
    };
    let failure: unknown;
    let iterator: ReturnType<CanonicalSourcePort['discover']> | undefined;
    try {
      context.signal.throwIfAborted();
      iterator = this.dependencies.source.discover(request, context);
      while (true) {
        const batch = await iterator.next();
        context.signal.throwIfAborted();
        if (batch.done) {
          completion = batch.value;
          break;
        }
        const discovered = getDiscoveredSources(batch.value, request.batchSize);
        for (const file of [...batch.value.files, ...batch.value.removed]) {
          if (fileIds.has(file.fileId)) {
            throw new Error('Canonical discovery repeated a file identity.');
          }
          fileIds.add(file.fileId);
        }
        assertUniqueWorkspacePaths(
          [...batch.value.files, ...batch.value.removed, ...discovered],
          workspacePaths
        );
        const manifest = await this.processBatch(
          request,
          context,
          ticket,
          batch.value.files,
          batch.value.removed,
          discovered,
          fileIds,
          profile,
          vectorFiles,
          excluded
        );
        files.push(...manifest);
      }
    } catch (error) {
      stopAdmission();
      failure = error;
      if (!context.signal.aborted) {
        completion = { ...completion, errors: [errorMessage(error)] };
      }
    } finally {
      if (iterator) {
        try {
          await retireSource(iterator, completion);
        } catch (error) {
          this.cleanupFailure = error;
          failure =
            failure === undefined
              ? error
              : new AggregateError([failure, error], 'Canonical source retirement failed.');
          completion = { ...completion, errors: [...completion.errors, errorMessage(error)] };
        }
      }
    }
    return { completion, excluded, failure, files };
  }

  private async processBatch(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket,
    files: readonly CanonicalSourceFile[],
    removed: readonly CanonicalFileIdentity[],
    discovered: readonly CanonicalDiscoveredSourceFile[],
    seenFileIds: Set<string>,
    profile: VectorProfile | undefined,
    vectorFiles: ScopedManifestFile[],
    excluded: CanonicalSourceExclusion[]
  ): Promise<CanonicalManifestFile[]> {
    const { catalog, publication, source } = this.dependencies;
    const authorized = await catalog.loadAuthorizedBatch(
      { files: [...files, ...removed], scope: request.scope },
      context
    );
    context.signal.throwIfAborted();
    const byId = authorizeBatch([...files, ...removed], authorized, request.scope);
    const { acknowledged, force } = await this.batchInventory(
      request,
      context,
      ticket,
      authorized,
      profile
    );
    const manifest: CanonicalManifestFile[] = [];
    const reads: CanonicalPreparedRead[] = [];
    const removals = [...removed];
    for (const file of files) {
      context.signal.throwIfAborted();
      const skipped = statCacheSkip(file, byId.get(file.fileId), force, acknowledged);
      if (skipped) {
        manifest.push({ ...file, contentHash: skipped.contentHash });
        vectorFiles.push(...skipped.vectorPlans);
        continue;
      }
      const read = await readCanonicalSource(source, file, request.maxFileBytes, context);
      if (read.kind === 'excluded') {
        excluded.push(read.exclusion);
        removals.push(file);
        continue;
      }
      reads.push({ ...read, file });
      manifest.push({ ...file, contentHash: read.contentHash });
    }
    if (reads.length > 0) {
      await catalog.applyManagedCacheBatch(
        {
          files: reads.map((read) => ({
            ...read.file,
            content: read.content,
            contentHash: read.contentHash,
            stat: read.stat,
          })),
          scope: request.scope,
        },
        context
      );
      context.signal.throwIfAborted();
    }
    const prepared = await prepareDiscoveredSources({
      catalog,
      context,
      discovered,
      excluded,
      membership: this.dependencies.managedCollectionId,
      request,
      seenFileIds,
      source,
    });
    reads.push(...prepared);
    manifest.push(...prepared.map((read) => ({ ...read.file, contentHash: read.contentHash })));
    const completed: { fileId: string; contentHash: string; chunkCount: number }[] = [];
    const vectorInputs: VectorFileInput[] = [];
    const ineligible = new Set<string>();
    for (const read of reads) {
      const outcome = await chunkCanonicalRead(this.chunk, read, request);
      context.signal.throwIfAborted();
      if (outcome.kind === 'excluded') {
        excluded.push(outcome.exclusion);
        removals.push(read.file);
        ineligible.add(read.file.fileId);
        continue;
      }
      const { payload } = outcome;
      if (profile) {
        vectorInputs.push({ file: read.file, payload });
      } else {
        await publication.commitTextFile({ file: read.file, payload, ticket });
      }
      context.signal.throwIfAborted();
      completed.push({
        chunkCount: payload.providedChunks.length,
        contentHash: read.contentHash,
        fileId: read.file.fileId,
      });
    }
    if (profile) {
      vectorFiles.push(...(await this.publishVectors(vectorInputs, profile, context, ticket)));
    }
    if (completed.length > 0) {
      await catalog.completeFiles({ files: completed, scope: request.scope }, context);
    }
    for (const file of removals) {
      context.signal.throwIfAborted();
      await publication.removeFile({ file, ticket });
      context.signal.throwIfAborted();
    }
    if (removals.length > 0) {
      await catalog.removeFiles({ files: removals, scope: request.scope }, context);
    }
    return ineligible.size === 0
      ? manifest
      : manifest.filter((file) => !ineligible.has(file.fileId));
  }
  /** The batch's native inventory: the files to force and, for a VECTOR scan, its acknowledged plans. */
  private async batchInventory(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket,
    authorized: readonly CanonicalCatalogFile[],
    profile: VectorProfile | undefined
  ): Promise<{
    readonly acknowledged: ReadonlyMap<string, ScopedManifestFile> | undefined;
    readonly force: ReadonlySet<string>;
  }> {
    const inventory = await this.dependencies.publication.verifyManifest({
      files: authorized.flatMap((file) =>
        file.contentHash === null ? [] : [{ ...file, contentHash: file.contentHash }]
      ),
      ...(profile === undefined ? {} : { profileHash: vectorProfileHash(profile) }),
      scope: request.scope,
    });
    context.signal.throwIfAborted();
    if (inventory.storeId !== ticket.storeId) {
      throw new Error('Canonical native inventory changed stores during its scan.');
    }
    return {
      acknowledged:
        profile === undefined
          ? undefined
          : new Map(inventory.acknowledged.map((plan) => [plan.fileId, plan])),
      force: new Set([
        ...[...inventory.missing, ...inventory.changed].map((file) => file.fileId),
        ...(request.forceFileIds ?? []),
      ]),
    };
  }
  private async publishVectors(
    inputs: readonly VectorFileInput[],
    profile: VectorProfile,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket
  ): Promise<ScopedManifestFile[]> {
    const dependencies = this.dependencies;
    if (dependencies.mode !== 'VECTOR') {
      throw new Error('VECTOR publication is not admitted.');
    }
    const files: PreparedVectorFile[] = [];
    for (const input of inputs) {
      await this.assertCurrentProfile(profile, context, ticket.scope);
      const plan = await dependencies.publication.prepareVectorFile({ ...input, profile, ticket });
      context.signal.throwIfAborted();
      validateVectorPlan(plan, input.file, input.payload, profile, ticket);
      files.push({ ...input, embeddings: [], plan });
    }
    const manifest: ScopedManifestFile[] = [];
    let nextCommit = 0;
    const commitReadyFiles = async (): Promise<void> => {
      while (nextCommit < files.length) {
        const file = files[nextCommit];
        if (!file) {
          throw new Error('Canonical prepared vector file is missing.');
        }
        if (file.embeddings.length !== file.plan.embeddingChunkIds.length) {
          return;
        }
        manifest.push(await this.commitVector(file, profile, context, ticket));
        nextCommit += 1;
      }
    };
    const batch: { file: PreparedVectorFile; chunk: { chunkId: string; content: string } }[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      const vectors = await this.infer(
        batch.map((entry) => entry.chunk),
        profile,
        context
      );
      for (const [index, entry] of batch.entries()) {
        const vector = vectors[index];
        if (!vector) {
          throw new Error('Canonical inference omitted an ordered vector.');
        }
        entry.file.embeddings.push(vector);
      }
      batch.length = 0;
      await commitReadyFiles();
    };
    await commitReadyFiles();
    for (const file of files) {
      const missing = new Set(file.plan.embeddingChunkIds);
      for (const chunk of file.plan.chunks) {
        if (!missing.has(chunk.chunkId)) {
          continue;
        }
        context.signal.throwIfAborted();
        batch.push({ chunk: { chunkId: chunk.chunkId, content: chunk.content }, file });
        if (batch.length === 64) {
          await flush();
        }
      }
    }
    await flush();
    await commitReadyFiles();
    if (nextCommit !== files.length) {
      throw new Error('Canonical vector batch omitted complete file publication.');
    }
    return manifest;
  }

  private async commitVector(
    { file, payload, plan, embeddings }: PreparedVectorFile,
    profile: VectorProfile,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket
  ): Promise<ScopedManifestFile> {
    const dependencies = this.dependencies;
    if (dependencies.mode !== 'VECTOR') {
      throw new Error('VECTOR publication is not admitted.');
    }
    context.signal.throwIfAborted();
    await this.assertCurrentProfile(profile, context, ticket.scope);
    await dependencies.publication.commitVectorFile({
      embeddings,
      file,
      plan,
      profile,
      syntax: payload.syntax,
      ticket,
    });
    context.signal.throwIfAborted();
    const { content: _content, ...binding } = plan.snapshot;
    return {
      chunks: plan.chunks.map(
        ({ content: _text, embeddingHash: _embeddingHash, ...chunk }) => chunk
      ),
      contentHash: plan.contentHash,
      embeddingSetId: binding.embeddingSetId,
      fileId: binding.fileId,
      relativePath: binding.relativePath,
      rootId: binding.rootId,
      sourcePath: binding.sourcePath,
    };
  }

  private async infer(
    chunks: readonly { readonly chunkId: string; readonly content: string }[],
    profile: VectorProfile,
    context: CanonicalOperationContext
  ): Promise<readonly { readonly chunkId: string; readonly vector: readonly number[] }[]> {
    const dependencies = this.dependencies;
    if (dependencies.mode !== 'VECTOR') {
      throw new Error('VECTOR inference is not admitted.');
    }
    const requestId = `${context.requestId}:${crypto.randomUUID()}`;
    this.inferenceRequests.add(requestId);
    const errors: unknown[] = [];
    let cancellation: Promise<void> | undefined;
    let cancellationJoined = false;
    let inferenceJoined = false;
    let generationFailed = false;
    const abort = (): void => {
      cancellation ??= Promise.resolve()
        .then(async () => {
          await dependencies.inference.cancel(requestId);
          cancellationJoined = true;
        })
        .catch((error: unknown) => {
          errors.push(error);
        });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    let vectors: readonly { readonly chunkId: string; readonly vector: readonly number[] }[] = [];
    try {
      context.signal.throwIfAborted();
      const result = await dependencies.inference
        .generate({ chunks, profile, requestId })
        .catch((error: unknown) => {
          generationFailed = true;
          throw error;
        });
      context.signal.throwIfAborted();
      if (
        result.requestId !== requestId ||
        vectorProfileHash(result.profile) !== vectorProfileHash(profile) ||
        result.vectors.length !== chunks.length
      ) {
        throw new Error(
          'Canonical inference response differs from its request or complete profile.'
        );
      }
      for (let index = 0; index < chunks.length; index += 1) {
        const vector = result.vectors[index];
        if (
          !(Object.hasOwn(result.vectors, index) && vector) ||
          vector.chunkId !== chunks[index]?.chunkId ||
          vector.vector.length !== profile.dimensions ||
          Array.from(vector.vector).some((value) => !Number.isFinite(value))
        ) {
          throw new Error(
            'Canonical inference requires exact ordered, dimensioned finite vectors.'
          );
        }
      }
      vectors = result.vectors;
    } catch (error) {
      errors.push(error);
      abort();
    } finally {
      if (cancellation !== undefined) {
        await cancellation;
      }
      try {
        await dependencies.inference.join(requestId);
        inferenceJoined = true;
        this.inferenceRequests.delete(requestId);
      } catch (error) {
        this.cleanupFailure = error;
        errors.push(error);
      }
      if (cancellation !== undefined) {
        await cancellation;
      }
      context.signal.removeEventListener('abort', abort);
    }
    // The scan was cancelled, and the generation's own failure is the only error: its cancel
    // (sent on the scan's abort, or after that failure) and its join both settled. It ends as the
    // scan's cancellation, which its callers type; how it ended is logged here once. A failed
    // cancel or join stays a failure of its own.
    if (
      context.signal.aborted &&
      generationFailed &&
      cancellationJoined &&
      inferenceJoined &&
      errors.length === 1
    ) {
      logger.debug('A cancelled scan reports its generation as its cancellation', {
        error: errors[0],
        requestId,
      });
      errors[0] = context.signal.reason;
    }
    const unique = [...new Set(errors)];
    if (unique.length === 1) {
      throw unique[0];
    }
    if (unique.length > 1) {
      throw new AggregateError(unique, 'Canonical inference and retirement failed.');
    }
    context.signal.throwIfAborted();
    return vectors;
  }

  private async assertCurrentProfile(
    profile: VectorProfile,
    context: CanonicalOperationContext,
    scope: CanonicalSourceScope
  ): Promise<void> {
    const dependencies = this.dependencies;
    if (dependencies.mode !== 'VECTOR') {
      throw new Error('VECTOR profile is not admitted.');
    }
    const current = await dependencies.catalog.resolveProfile({ scope }, context);
    context.signal.throwIfAborted();
    if (vectorProfileHash(current) !== vectorProfileHash(profile)) {
      throw new Error('Canonical saved vector profile changed during its scan.');
    }
  }

  private async verifyVectorCompletion(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket,
    profile: VectorProfile,
    files: readonly ScopedManifestFile[]
  ): Promise<void> {
    const dependencies = this.dependencies;
    if (dependencies.mode !== 'VECTOR') {
      throw new Error('VECTOR completion is not admitted.');
    }
    await this.assertCurrentProfile(profile, context, request.scope);
    let manifest: ScopedManifestResult;
    let coverage: ScopedCoverage;
    for (let read = 1; ; read += 1) {
      manifest = await dependencies.publication.verifyVectorManifest({
        files,
        scope: request.scope,
      });
      context.signal.throwIfAborted();
      coverage = await dependencies.publication.vectorCoverage({
        profile,
        scope: request.scope,
      });
      context.signal.throwIfAborted();
      const moved =
        coverage.storeId === manifest.storeId &&
        coverage.authorityEpoch === manifest.authorityEpoch &&
        coverage.authorityRevision > manifest.authorityRevision;
      if (!moved || read >= VECTOR_PROOF_READS) {
        break;
      }
    }
    if (
      !(
        manifest.complete &&
        manifestVectorsComplete(coverage) &&
        manifest.storeId === ticket.storeId &&
        coverage.storeId === ticket.storeId &&
        sameScope(manifest.scope, request.scope) &&
        sameScope(coverage.scope, request.scope) &&
        manifest.authorityEpoch === coverage.authorityEpoch &&
        manifest.authorityRevision === coverage.authorityRevision &&
        coverage.profile !== null &&
        coverage.profileHash === vectorProfileHash(profile) &&
        vectorProfileHash(coverage.profile) === vectorProfileHash(profile)
      )
    ) {
      throw new Error(
        'Canonical VECTOR completion requires the full current scoped manifest and selected-profile coverage.'
      );
    }
  }
}

async function retireSource(
  iterator: ReturnType<CanonicalSourcePort['discover']>,
  completion: CanonicalDiscoveryCompletion
): Promise<void> {
  let retirement = await iterator.return(completion);
  while (!retirement.done) {
    // A finally block may yield. Resume it without publishing yielded
    // batches; another return() would skip the remaining cleanup.
    retirement = await iterator.next();
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
function sameScope(left: ScopedManifestResult['scope'], right: CanonicalSourceScope): boolean {
  return left.kind === 'workspace' && left.rootId === right.rootId;
}
function sameTicket(left: CanonicalScanTicket, right: CanonicalScanTicket): boolean {
  return (
    left.storeId === right.storeId &&
    left.requestId === right.requestId &&
    left.generation === right.generation &&
    sameScope(left.scope, right.scope)
  );
}
function authorizeBatch(
  files: readonly CanonicalFileIdentity[],
  authorized: readonly CanonicalCatalogFile[],
  scope: CanonicalSourceScope
): ReadonlyMap<string, CanonicalCatalogFile> {
  const byId = new Map(authorized.map((file) => [file.fileId, file]));
  if (files.length !== authorized.length || byId.size !== files.length) {
    throw new Error('Canonical catalog did not authorize the exact discovered batch.');
  }
  for (const file of files) {
    const actual = byId.get(file.fileId);
    if (
      !actual ||
      file.rootId !== actual.rootId ||
      file.relativePath !== actual.relativePath ||
      file.embeddingSetId !== actual.embeddingSetId ||
      file.sourcePath !== actual.sourcePath ||
      file.fileName !== actual.fileName
    ) {
      throw new Error('Canonical source binding differs from the authoritative catalog.');
    }
    if (actual.rootId !== scope.rootId) {
      throw new Error('Canonical file is outside its authorized scope.');
    }
  }
  return byId;
}

function assertExecutableProfile(profile: VectorProfile): void {
  vectorProfileHash(profile);
}
function validateVectorPlan(
  plan: ScopedFilePlan,
  file: CanonicalFileIdentity,
  payload: CanonicalIndexPayload,
  profile: VectorProfile,
  ticket: CanonicalScanTicket
): void {
  const snapshot = plan.snapshot;
  if (
    plan.storeId !== ticket.storeId ||
    !plan.profile ||
    plan.profileHash !== vectorProfileHash(profile) ||
    vectorProfileHash(plan.profile) !== vectorProfileHash(profile) ||
    snapshot.fileId !== file.fileId ||
    payload.fileId !== file.fileId ||
    snapshot.rootId !== file.rootId ||
    snapshot.relativePath !== file.relativePath ||
    snapshot.sourcePath !== file.sourcePath ||
    snapshot.embeddingSetId !== file.embeddingSetId ||
    snapshot.content !== payload.content ||
    plan.contentHash !== createHash('sha256').update(payload.content).digest('hex') ||
    !('providedChunks' in snapshot) ||
    snapshot.providedChunks.length !== payload.providedChunks.length ||
    snapshot.providedChunks.some((actual, index) => {
      const expected = payload.providedChunks[index];
      return (
        !expected ||
        Object.entries(expected).some(([key, value]) => Reflect.get(actual, key) !== value)
      );
    })
  ) {
    throw new Error(
      'Canonical vector plan differs from its source, scope, store or complete profile.'
    );
  }
  if (
    plan.chunks.length !== payload.providedChunks.length ||
    new Set(plan.chunks.map((chunk) => chunk.chunkId)).size !== plan.chunks.length ||
    new Set(plan.embeddingChunkIds).size !== plan.embeddingChunkIds.length
  ) {
    throw new Error('Canonical vector plan contains duplicate or incomplete chunks.');
  }
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const actual = plan.chunks[index];
    const expected = payload.providedChunks[index];
    if (
      !(actual && expected) ||
      Object.entries(expected).some(([key, value]) => Reflect.get(actual, key) !== value)
    ) {
      throw new Error('Canonical vector plan changed canonical chunk order or metadata.');
    }
  }
  const missing = new Set(plan.embeddingChunkIds);
  if (
    JSON.stringify(
      plan.chunks.filter((chunk) => missing.has(chunk.chunkId)).map((chunk) => chunk.chunkId)
    ) !== JSON.stringify(plan.embeddingChunkIds)
  ) {
    throw new Error('Canonical missing vector list must be an ordered subset of actual chunks.');
  }
}

function hasCompleteDiscovery(outcome: DiscoveryOutcome): boolean {
  return (
    outcome.failure === undefined &&
    outcome.completion.full &&
    outcome.completion.errors.length === 0 &&
    outcome.completion.truncatedDirectories.length === 0
  );
}
