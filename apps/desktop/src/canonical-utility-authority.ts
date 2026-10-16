import path from 'node:path';
import type {
  CanonicalCatalogPort,
  CanonicalFileIdentity,
  CanonicalInferencePort,
  CanonicalIngestionDependencies,
  CanonicalPublicationPort,
  CanonicalScanRequest,
  CanonicalSourceInventoryPort,
  CanonicalSourceScope,
  CanonicalSourceSubscription,
  CanonicalVectorPublicationPort,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
  CanonicalWorkspaceSourceDependencies,
  NodeChunkerOptions,
} from '@brainstrike/canonical-ingestion';
import type { ScopedManifestFile, VectorProfile } from '@brainstrike/indexer';
import { Schema } from 'effect';
import {
  type CanonicalFrame,
  type CanonicalUtilityConfig,
  canonicalOperations,
  decode,
  identitySchema,
  scopeSchema,
  ticketSchema,
} from './canonical-utility-protocol';

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;
/**
 * Main's description of an ingestion the utility hosts: its dependencies,
 * naming the parser the utility builds its chunker from. Canonical chunking
 * never runs in main.
 */
type Remote<T> = T extends unknown
  ? Omit<T, 'chunker'> & { readonly parser: NodeChunkerOptions }
  : never;
export type CanonicalRemoteIngestion = Remote<WithoutSource<CanonicalIngestionDependencies>>;
export type CanonicalRemoteWorkspaceDependencies = Remote<CanonicalWorkspaceRuntimeDependencies>;
export type CanonicalCollectionDependencies = CanonicalRemoteIngestion & {
  readonly request: Omit<CanonicalScanRequest, 'requestId' | 'scope' | 'forceFileIds'>;
  readonly scope: Extract<CanonicalSourceScope, { kind: 'collection' }>;
  readonly source: Omit<CanonicalWorkspaceSourceDependencies, 'lease' | 'resolveScanScope'>;
};
export interface Session {
  readonly catalog: CanonicalCatalogPort;
  childClosed: boolean;
  close?: Promise<void> | undefined;
  readonly config: CanonicalUtilityConfig;
  readonly dependencies: CanonicalRemoteWorkspaceDependencies | CanonicalCollectionDependencies;
  readonly files: Map<string, CanonicalFileIdentity>;
  readonly inference: CanonicalInferencePort<VectorProfile> | undefined;
  readonly inferenceRequests: Set<string>;
  readonly inventory: CanonicalSourceInventoryPort;
  lastRequestId: number;
  readonly lease: CanonicalWorkspaceLease | undefined;
  readonly pending: Map<number, { controller: AbortController; settled: Promise<void> }>;
  readonly publication: CanonicalPublicationPort;
  stopping: boolean;
  subscription?: CanonicalSourceSubscription | undefined;
  subscriptionAcquired: boolean;
  readonly transportErrors: Set<unknown>;
  readonly usedInferenceRequests: Set<string>;
  readonly vectorPublication: CanonicalVectorPublicationPort | undefined;
}
const cleanupOperations = new Set([
  'unsubscribe',
  'retire-lease',
  'abort-scan',
  'inference-cancel',
  'inference-join',
]);
export function isOwnedCleanup(frame: Extract<CanonicalFrame, { kind: 'call' }>): boolean {
  if (frame.op !== 'finish-scan') {
    return cleanupOperations.has(frame.op);
  }
  const input = decode(canonicalOperations['finish-scan'].input)(frame.payload);
  return (
    input.aborted || input.errors.length > 0 || !input.full || input.truncatedDirectories.length > 0
  );
}

export function assertMode(dependencies: Session['dependencies']): void {
  Schema.decodeUnknownSync(
    Schema.Struct({ mode: Schema.optionalKey(Schema.Literals(['TEXT', 'VECTOR'])) })
  )(dependencies);
  if (dependencies.mode !== 'VECTOR') {
    return;
  }
  const vector = Schema.decodeUnknownSync(
    Schema.Struct({
      inference: Schema.Struct({
        cancel: Schema.Unknown,
        generate: Schema.Unknown,
        join: Schema.Unknown,
      }),
      publication: Schema.Struct({
        commitVectorFile: Schema.Unknown,
        prepareVectorFile: Schema.Unknown,
        vectorCoverage: Schema.Unknown,
        verifyVectorManifest: Schema.Unknown,
      }),
    })
  )(dependencies);
  if (
    [...Object.values(vector.inference), ...Object.values(vector.publication)].some(
      (method) => typeof method !== 'function'
    )
  ) {
    throw new Error(
      'Explicit VECTOR requires complete actual inference and publication callbacks.'
    );
  }
}
export function sameScope(left: CanonicalSourceScope, right: CanonicalSourceScope): boolean {
  return left.kind === 'workspace' && right.kind === 'workspace'
    ? left.rootId === right.rootId
    : left.kind === 'collection' &&
        right.kind === 'collection' &&
        left.embeddingSetId === right.embeddingSetId;
}
function sameFile(left: CanonicalFileIdentity, right: CanonicalFileIdentity): boolean {
  return (
    left.fileId === right.fileId &&
    left.fileName === right.fileName &&
    left.rootId === right.rootId &&
    left.relativePath === right.relativePath &&
    left.sourcePath === right.sourcePath &&
    left.embeddingSetId === right.embeddingSetId
  );
}
function assertFileScope(file: CanonicalFileIdentity, config: CanonicalUtilityConfig): void {
  if (config.scope.kind === 'workspace') {
    if (
      file.rootId !== config.scope.rootId ||
      !file.relativePath ||
      !config.lease ||
      file.sourcePath !== path.join(config.lease.canonicalPath, file.relativePath)
    ) {
      throw new Error('Canonical file is outside its captured workspace.');
    }
    assertRelative(file.relativePath);
  } else if (file.embeddingSetId !== config.scope.embeddingSetId) {
    throw new Error('Rootless canonical file is outside its captured collection.');
  }
}
export function assertRelative(value: string, directory = false): void {
  if (directory && value === '.') {
    return;
  }
  if (
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Canonical path must be a normalized relative path.');
  }
}

export function capturedAuthority(
  session: Session,
  frame: Extract<CanonicalFrame, { kind: 'call' }>
) {
  const { dependencies: deps, config } = session;
  const cleanup = isOwnedCleanup(frame);
  const lease = session.lease;
  const liveLease = 'lease' in deps.source ? deps.source.lease : undefined;
  if (
    !cleanup &&
    ((deps.mode ?? 'TEXT') !== config.mode ||
      (deps.mode === 'VECTOR' && deps.inference !== session.inference) ||
      liveLease !== lease ||
      deps.catalog !== session.catalog ||
      deps.publication !== session.publication ||
      deps.source.inventory !== session.inventory)
  ) {
    throw new Error('Canonical mounted capability object changed its captured owner.');
  }
  if (
    !cleanup &&
    lease &&
    (!config.lease ||
      lease.rootId !== config.lease.rootId ||
      lease.generation !== config.lease.generation ||
      lease.canonicalPath !== config.lease.canonicalPath)
  ) {
    throw new Error('Canonical mounted capability changed its captured generation.');
  }
  const scope = (actual: CanonicalSourceScope): void => {
    if (!sameScope(actual, config.scope)) {
      throw new Error('Canonical request is outside its captured scope.');
    }
  };
  const files = (actual: readonly CanonicalFileIdentity[], bound = true): void => {
    if (bound && actual.length > config.request.batchSize) {
      throw new Error('Canonical request exceeds its captured batch bound.');
    }
    for (const file of actual) {
      assertFileScope(file, config);
      const captured = session.files.get(file.fileId);
      if (!(captured && (cleanup || sameFile(captured, file)))) {
        throw new Error('Canonical file is outside its captured inventory.');
      }
    }
  };
  const remember = (actual: readonly CanonicalFileIdentity[]): void => {
    for (const file of actual) {
      assertFileScope(file, config);
      session.files.set(file.fileId, file);
    }
  };
  const ownedLease = (): NonNullable<typeof lease> => {
    if (!lease || (lease.signal.aborted && !cleanup)) {
      throw new Error('Canonical request has no live mounted lease.');
    }
    return lease;
  };
  return { files, lease, ownedLease, remember, scope };
}

export function recheckCallbackAuthority(
  session: Session,
  frame: Extract<CanonicalFrame, { kind: 'call' }>
): void {
  const current = capturedAuthority(session, frame);
  if (frame.payload === null) {
    return;
  }
  if (frame.op === 'load-files') {
    current.scope(decode(scopeSchema)(frame.payload));
    return;
  }
  // Project authority fields from the already strictly validated operation DTO.
  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      file: Schema.optionalKey(identitySchema),
      scope: Schema.optionalKey(scopeSchema),
      ticket: Schema.optionalKey(ticketSchema),
    })
  )(frame.payload);
  if (input.scope) {
    current.scope(input.scope);
  }
  if (input.ticket) {
    current.scope(input.ticket.scope);
  }
  if (input.file) {
    current.files([input.file]);
  }
  if (frame.op === 'verify-vector-manifest') {
    assertVectorManifestAuthority(
      session,
      current,
      decode(canonicalOperations['verify-vector-manifest'].input)(frame.payload).files
    );
    return;
  }
  if (frame.op === 'prepare-sources') {
    const prepared = decode(canonicalOperations['prepare-sources'].input)(frame.payload);
    for (const file of prepared.files) {
      assertDiscoveredSource(file, session.config);
    }
    return;
  }
  if (frame.op === 'complete-files') {
    const completed = decode(canonicalOperations['complete-files'].input)(frame.payload);
    if (completed.files.some((file) => !session.files.has(file.fileId))) {
      throw new Error('Canonical completion lost its captured file authority.');
    }
    return;
  }
  if (
    ['load-authorized', 'apply-cache', 'remove-files', 'finish-scan', 'verify-manifest'].includes(
      frame.op
    )
  ) {
    const batch = Schema.decodeUnknownSync(Schema.Struct({ files: Schema.Array(identitySchema) }))(
      frame.payload
    );
    current.files(batch.files, false);
  }
}
export function assertVectorManifestAuthority(
  session: Session,
  authority: ReturnType<typeof capturedAuthority>,
  files: readonly ScopedManifestFile[]
): void {
  for (const file of files) {
    const captured = session.files.get(file.fileId);
    if (!captured) {
      throw new Error('Vector manifest has an uncaptured file.');
    }
    authority.files([{ ...file, fileName: captured.fileName }], false);
  }
}

export function assertDiscoveredSource(
  file: {
    readonly relativePath: string;
    readonly rootId: string;
    readonly sourcePath: string;
    readonly fileName: string;
    readonly content: string;
  },
  config: CanonicalUtilityConfig
): void {
  assertRelative(file.relativePath);
  if (
    !config.lease ||
    file.rootId !== config.lease.rootId ||
    file.sourcePath !== path.join(config.lease.canonicalPath, file.relativePath) ||
    file.fileName !== path.basename(file.relativePath) ||
    Buffer.byteLength(file.content) > config.request.maxFileBytes
  ) {
    throw new Error('Discovered source differs from the captured mounted path or bound.');
  }
}
