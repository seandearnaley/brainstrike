import { createHash } from 'node:crypto';
import type {
  CanonicalCatalogPort,
  CanonicalDiscoveredSourceFile,
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalOperationContext,
  CanonicalScanRequest,
  CanonicalSourceBatch,
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceStat,
} from './ports.js';

export interface CanonicalPreparedRead {
  readonly content: string;
  readonly contentHash: string;
  readonly file: CanonicalSourceFile;
  readonly stat: CanonicalSourceStat;
}

export function getDiscoveredSources(
  batch: CanonicalSourceBatch,
  batchSize: number
): readonly CanonicalDiscoveredSourceFile[] {
  const discovered = batch.discovered ?? [];
  if (batch.files.length + batch.removed.length + discovered.length > batchSize) {
    throw new Error('Canonical discovery exceeded its explicit batch bound.');
  }
  return discovered;
}

export async function readCanonicalSource(
  source: CanonicalSourcePort,
  file: CanonicalSourceFile | CanonicalDiscoveredSourceFile,
  maxFileBytes: number,
  context: CanonicalOperationContext
): Promise<{
  readonly content: string;
  readonly contentHash: string;
  readonly stat: CanonicalSourceStat;
}> {
  context.signal.throwIfAborted();
  const read = await source.read(file, maxFileBytes, context);
  context.signal.throwIfAborted();
  if (Buffer.byteLength(read.content, 'utf8') > maxFileBytes) {
    throw new Error('Canonical source exceeds its explicit read bound.');
  }
  return {
    ...read,
    contentHash: createHash('sha256').update(read.content, 'utf8').digest('hex'),
  };
}

function sourceKey(file: {
  readonly rootId: string | null;
  readonly relativePath: string | null;
}): string {
  return JSON.stringify([file.rootId, file.relativePath]);
}

export function assertUniqueWorkspacePaths(
  files: readonly Pick<CanonicalFileIdentity, 'rootId' | 'relativePath'>[],
  seenPaths: Set<string>
): void {
  for (const file of files) {
    if (file.rootId === null || file.relativePath === null) {
      continue;
    }
    const key = sourceKey(file);
    if (seenPaths.has(key)) {
      throw new Error('Canonical discovery repeated a workspace path.');
    }
    seenPaths.add(key);
  }
}

function validateDiscoveries(
  discovered: readonly CanonicalDiscoveredSourceFile[],
  request: CanonicalScanRequest
): Extract<CanonicalScanRequest['scope'], { readonly kind: 'workspace' }> {
  const { scope } = request;
  if (scope.kind !== 'workspace') {
    throw new Error('Unregistered filesystem discovery requires an authorized workspace scope.');
  }
  for (const file of discovered) {
    if (
      file.rootId !== scope.rootId ||
      !file.rootId.trim() ||
      !file.relativePath.trim() ||
      !file.sourcePath.trim() ||
      !file.fileName.trim()
    ) {
      throw new Error('Canonical discovered source is outside its workspace binding.');
    }
  }
  return scope;
}

function validateBindings(
  reads: readonly (CanonicalDiscoveredSourceFile & { readonly contentHash: string })[],
  bindings: readonly CanonicalManifestFile[],
  seenFileIds: Set<string>
): ReadonlyMap<string, CanonicalManifestFile> {
  const byPath = new Map(bindings.map((file) => [sourceKey(file), file]));
  const returnedIds = new Set(bindings.map((file) => file.fileId));
  if (
    bindings.length !== reads.length ||
    byPath.size !== reads.length ||
    returnedIds.size !== reads.length
  ) {
    throw new Error('Canonical preparation did not return the exact discovered batch.');
  }
  for (const read of reads) {
    const actual = byPath.get(sourceKey(read));
    if (!actual) {
      throw new Error('Canonical prepared source differs from its authoritative catalog binding.');
    }
    if (
      !(actual.fileId.trim() && actual.embeddingSetId?.trim()) ||
      actual.fileName !== read.fileName ||
      actual.sourcePath !== read.sourcePath ||
      actual.contentHash !== read.contentHash
    ) {
      throw new Error('Canonical prepared source differs from its authoritative catalog binding.');
    }
    if (seenFileIds.has(actual.fileId)) {
      throw new Error('Canonical discovery repeated a file identity.');
    }
  }
  for (const fileId of returnedIds) {
    seenFileIds.add(fileId);
  }
  return byPath;
}

export async function prepareDiscoveredSources(args: {
  readonly catalog: CanonicalCatalogPort;
  readonly context: CanonicalOperationContext;
  readonly discovered: readonly CanonicalDiscoveredSourceFile[];
  readonly request: CanonicalScanRequest;
  readonly seenFileIds: Set<string>;
  readonly source: CanonicalSourcePort;
}): Promise<CanonicalPreparedRead[]> {
  if (args.discovered.length === 0) {
    return [];
  }
  const scope = validateDiscoveries(args.discovered, args.request);
  const reads = [];
  for (const file of args.discovered) {
    const read = await readCanonicalSource(
      args.source,
      file,
      args.request.maxFileBytes,
      args.context
    );
    reads.push({ ...file, ...read });
  }
  const bindings = await args.catalog.prepareManagedSourcesBatch(
    { files: reads, scope },
    args.context
  );
  args.context.signal.throwIfAborted();
  const byPath = validateBindings(reads, bindings, args.seenFileIds);
  return reads.map((read) => {
    const binding = byPath.get(sourceKey(read));
    if (!binding) {
      throw new Error('Canonical prepared source binding is absent.');
    }
    const { contentHash: _hash, ...identity } = binding;
    return {
      content: read.content,
      contentHash: read.contentHash,
      file: { ...identity, stat: read.stat },
      stat: read.stat,
    };
  });
}
