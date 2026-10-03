import { createHash } from 'node:crypto';
import {
  createNodeChunker,
  type NodeChunker,
  type NodeChunkerOptions,
} from '@brainstrike/chunking-worker/node';
import type { CanonicalChunkEvent } from '@brainstrike/file-import';
import { canonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import type {
  CanonicalCatalogFile,
  CanonicalCatalogPort,
  CanonicalDiscoveryCompletion,
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalOperationContext,
  CanonicalPublicationPort,
  CanonicalScanReceipt,
  CanonicalScanRequest,
  CanonicalScanTicket,
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceScope,
} from './ports.js';

interface ActiveScan {
  readonly controller: AbortController;
  error: unknown;
  readonly requestId: string;
  readonly settled: Promise<void>;
}
interface DiscoveryOutcome {
  readonly completion: CanonicalDiscoveryCompletion;
  readonly failure: unknown;
  readonly files: readonly CanonicalManifestFile[];
}
export interface CanonicalIngestionDependencies {
  readonly catalog: CanonicalCatalogPort;
  readonly parser: NodeChunkerOptions;
  readonly publication: CanonicalPublicationPort;
  readonly source: CanonicalSourcePort;
}

/** One utility-owned scan. Existing source/coalescing and receipt adapters remain the authorities. */
export class CanonicalIngestionHost {
  private active: ActiveScan | undefined;
  private closed = false;
  private cleanupFailure: unknown;
  private readonly chunk: NodeChunker;

  constructor(private readonly dependencies: CanonicalIngestionDependencies) {
    this.chunk = createNodeChunker(dependencies.parser);
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
    const run = this.run(request, { requestId: request.requestId, signal: controller.signal });
    const active: ActiveScan = {
      controller,
      error: undefined,
      requestId: request.requestId,
      settled: run.then(
        () => {},
        (error: unknown) => {
          active.error = error;
        }
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

  async cancel(requestId: string): Promise<void> {
    const active = this.active;
    if (!active || active.requestId !== requestId) {
      throw new Error('Canonical cancellation request is stale or unknown.');
    }
    active.controller.abort(new DOMException('Canonical scan cancelled.', 'AbortError'));
    await active.settled;
    if (active.error !== undefined && active.error !== active.controller.signal.reason) {
      throw active.error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const errors: unknown[] = [];
    if (this.active) {
      try {
        await this.cancel(this.active.requestId);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.dependencies.source.close();
      this.cleanupFailure = undefined;
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
    const ticket = await publication.beginScan({
      requestId: request.requestId,
      scope: request.scope,
    });
    if (ticket.requestId !== request.requestId || !sameScope(ticket.scope, request.scope)) {
      throw new Error('Canonical scan ticket differs from its requested authority.');
    }
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
    const {
      completion,
      files,
      failure: discoveryFailure,
    } = await this.collectManifest(request, context, ticket);
    let failure = discoveryFailure;
    let receipt: CanonicalScanReceipt | undefined;
    try {
      receipt = await publication.finishScan({
        ...completion,
        aborted: context.signal.aborted,
        files,
        ticket,
      });
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], 'Canonical scan completion failed.');
    }
    // A notice admitted during manifest completion must physically settle.
    if (abortNotice) {
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
    if (!receipt?.scanComplete) {
      throw new Error(`Canonical scan receipt is incomplete: ${receipt?.reason ?? 'missing'}.`);
    }
    if (!sameTicket(receipt.ticket, ticket)) {
      throw new Error('Canonical scan receipt belongs to another generation.');
    }
    return receipt;
  }

  private async collectManifest(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket
  ): Promise<DiscoveryOutcome> {
    const files: CanonicalManifestFile[] = [];
    const fileIds = new Set<string>();
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
        if (batch.value.files.length + batch.value.removed.length > request.batchSize) {
          throw new Error('Canonical discovery exceeded its explicit batch bound.');
        }
        for (const file of [...batch.value.files, ...batch.value.removed]) {
          if (fileIds.has(file.fileId)) {
            throw new Error('Canonical discovery repeated a file identity.');
          }
          fileIds.add(file.fileId);
        }
        const manifest = await this.processBatch(
          request,
          context,
          ticket,
          batch.value.files,
          batch.value.removed
        );
        files.push(...manifest);
      }
    } catch (error) {
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
    return { completion, failure, files };
  }

  private async processBatch(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext,
    ticket: CanonicalScanTicket,
    files: readonly CanonicalSourceFile[],
    removed: readonly CanonicalFileIdentity[]
  ): Promise<CanonicalManifestFile[]> {
    const { catalog, publication, source } = this.dependencies;
    const authorized = await catalog.loadAuthorizedBatch(
      { files: [...files, ...removed], scope: request.scope },
      context
    );
    context.signal.throwIfAborted();
    const byId = authorizeBatch([...files, ...removed], authorized, request.scope);
    const existingManifest = authorized.flatMap((file) =>
      file.contentHash === null ? [] : [{ ...file, contentHash: file.contentHash }]
    );
    const inventory = await publication.verifyManifest({
      files: existingManifest,
      scope: request.scope,
    });
    context.signal.throwIfAborted();
    if (inventory.storeId !== ticket.storeId) {
      throw new Error('Canonical native inventory changed stores during its scan.');
    }
    const force = new Set([...inventory.missing, ...inventory.changed].map((file) => file.fileId));
    for (const fileId of request.forceFileIds ?? []) {
      force.add(fileId);
    }
    const manifest: CanonicalManifestFile[] = [];
    const reads: {
      file: CanonicalSourceFile;
      content: string;
      stat: CanonicalSourceFile['stat'];
      contentHash: string;
    }[] = [];
    for (const file of files) {
      context.signal.throwIfAborted();
      const prior = byId.get(file.fileId);
      if (
        prior &&
        !force.has(file.fileId) &&
        isStatCacheHit(file, prior) &&
        prior.contentHash !== null
      ) {
        manifest.push({ ...file, contentHash: prior.contentHash });
        continue;
      }
      const read = await source.read(file, request.maxFileBytes, context);
      context.signal.throwIfAborted();
      if (Buffer.byteLength(read.content, 'utf8') > request.maxFileBytes) {
        throw new Error('Canonical source exceeds its explicit read bound.');
      }
      const contentHash = createHash('sha256').update(read.content, 'utf8').digest('hex');
      reads.push({ ...read, contentHash, file });
      manifest.push({ ...file, contentHash });
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
    const completed: { fileId: string; contentHash: string; chunkCount: number }[] = [];
    for (const read of reads) {
      const original = {
        content: read.content,
        fileName: read.file.fileName,
        filePath: read.file.relativePath ?? read.file.sourcePath ?? read.file.fileName,
        fileRecordId: read.file.fileId,
      };
      const event: CanonicalChunkEvent =
        read.content === ''
          ? { kind: 'empty-source', source: original }
          : {
              kind: 'worker-result',
              result: {
                ...(await this.chunk(read.content, {
                  ...request.chunkingOptions,
                  fileName: original.fileName,
                  filePath: original.filePath,
                })),
                fileRecordId: read.file.fileId,
                id: request.requestId,
                type: 'result',
              },
              source: original,
            };
      context.signal.throwIfAborted();
      const payload = canonicalIndexPayload(event);
      await publication.commitTextFile({ file: read.file, payload, ticket });
      context.signal.throwIfAborted();
      completed.push({
        chunkCount: payload.providedChunks.length,
        contentHash: read.contentHash,
        fileId: read.file.fileId,
      });
    }
    if (completed.length > 0) {
      await catalog.completeFiles({ files: completed, scope: request.scope }, context);
    }
    for (const file of removed) {
      context.signal.throwIfAborted();
      await publication.removeFile({ file, ticket });
      context.signal.throwIfAborted();
    }
    if (removed.length > 0) {
      await catalog.removeFiles({ files: removed, scope: request.scope }, context);
    }
    return manifest;
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
function sameScope(left: CanonicalSourceScope, right: CanonicalSourceScope): boolean {
  if (left.kind === 'workspace' && right.kind === 'workspace') {
    return left.rootId === right.rootId;
  }
  if (left.kind === 'collection' && right.kind === 'collection') {
    return left.embeddingSetId === right.embeddingSetId;
  }
  return false;
}
function sameTicket(left: CanonicalScanTicket, right: CanonicalScanTicket): boolean {
  return (
    left.storeId === right.storeId &&
    left.requestId === right.requestId &&
    left.generation === right.generation &&
    sameScope(left.scope, right.scope)
  );
}
function isStatCacheHit(file: CanonicalSourceFile, prior: CanonicalCatalogFile): boolean {
  return (
    prior.chunksProcessed &&
    prior.stat.mtimeMs !== null &&
    file.stat.mtimeMs !== null &&
    prior.stat.size === file.stat.size &&
    prior.stat.mtimeMs === Math.floor(file.stat.mtimeMs)
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
    if (
      (scope.kind === 'workspace' && actual.rootId !== scope.rootId) ||
      (scope.kind === 'collection' && actual.embeddingSetId !== scope.embeddingSetId)
    ) {
      throw new Error('Canonical file is outside its authorized scope.');
    }
  }
  return byId;
}
