import {
  assertRelative,
  capturedAuthority,
  recheckCallbackAuthority,
  type Session,
} from './canonical-utility-authority';
import { type CanonicalFrame, canonicalOperations, decode } from './canonical-utility-protocol';

type Request = Extract<CanonicalFrame, { kind: 'call' }>;

/** Pre-invocation authority checks shared by live admission and stopped refusals. */
export function assertCanonicalRequest(session: Session, frame: Request): void {
  if (!Object.hasOwn(canonicalOperations, frame.op)) {
    throw new Error('Unknown canonical utility operation.');
  }
  const operation = canonicalOperations[frame.op as keyof typeof canonicalOperations];
  decode(operation.input)(frame.payload);
  recheckCallbackAuthority(session, frame);
  assertLeaseRequest(session, frame);
  assertCatalogRequest(session, frame);
  assertPublicationRequest(session, frame);
}

function assertLeaseRequest(session: Session, frame: Request): void {
  if (!['list-dir', 'read-file', 'subscribe'].includes(frame.op)) {
    return;
  }
  capturedAuthority(session, frame).ownedLease();
  if (frame.op === 'subscribe') {
    if (session.subscriptionAcquired) {
      throw new Error('Canonical watcher already has an owner.');
    }
    return;
  }
  if (frame.op === 'list-dir') {
    const input = decode(canonicalOperations['list-dir'].input)(frame.payload);
    assertRelative(input.relativePath, true);
    if (input.maxEntries > 10_000) {
      throw new Error('Canonical directory entry bound exceeded.');
    }
    return;
  }
  const input = decode(canonicalOperations['read-file'].input)(frame.payload);
  assertRelative(input.relativePath);
  if (input.maxBytes > session.config.request.maxFileBytes) {
    throw new Error('Canonical source read bound exceeded.');
  }
}

function assertCatalogRequest(session: Session, frame: Request): void {
  const { config } = session;
  switch (frame.op) {
    case 'read-retained': {
      const input = decode(canonicalOperations['read-retained'].input)(frame.payload);
      if (config.scope.kind !== 'collection' || input.maxFileBytes > config.request.maxFileBytes) {
        throw new Error('Retained read exceeds collection authority or byte bound.');
      }
      break;
    }
    case 'prepare-sources': {
      const input = decode(canonicalOperations['prepare-sources'].input)(frame.payload);
      if (input.scope.kind !== 'workspace' || input.files.length > config.request.batchSize) {
        throw new Error('Discovered batch has no captured workspace authority.');
      }
      break;
    }
    case 'apply-cache': {
      const input = decode(canonicalOperations['apply-cache'].input)(frame.payload);
      capturedAuthority(session, frame).files(input.files);
      if (
        input.files.some((file) => Buffer.byteLength(file.content) > config.request.maxFileBytes)
      ) {
        throw new Error('Canonical cache source exceeds bound.');
      }
      break;
    }
    case 'load-authorized':
    case 'remove-files': {
      const input = decode(canonicalOperations[frame.op].input)(frame.payload);
      capturedAuthority(session, frame).files(input.files);
      break;
    }
    case 'complete-files': {
      const input = decode(canonicalOperations['complete-files'].input)(frame.payload);
      if (input.files.length > config.request.batchSize) {
        throw new Error('Canonical completion has foreign or oversized file identities.');
      }
      break;
    }
    case 'resolve-profile':
      if (config.mode !== 'VECTOR') {
        throw new Error('TEXT cannot resolve inference profiles.');
      }
      break;
    default:
      break;
  }
}

function assertPublicationRequest(session: Session, frame: Request): void {
  if (frame.op === 'inference-generate') {
    if (!session.inference) {
      throw new Error('Inference requires explicit captured VECTOR dependencies.');
    }
    const input = decode(canonicalOperations['inference-generate'].input)(frame.payload);
    if (session.usedInferenceRequests.has(input.requestId)) {
      throw new Error('Canonical inference operation already has an owner.');
    }
  }
  if (
    ['prepare-vector', 'commit-vector', 'verify-vector-manifest', 'vector-coverage'].includes(
      frame.op
    ) &&
    !session.vectorPublication
  ) {
    throw new Error('Vector publication requires explicit captured VECTOR dependencies.');
  }
  switch (frame.op) {
    case 'prepare-vector':
    case 'commit-text': {
      const input =
        frame.op === 'prepare-vector'
          ? decode(canonicalOperations['prepare-vector'].input)(frame.payload)
          : decode(canonicalOperations['commit-text'].input)(frame.payload);
      if (
        input.file.fileId !== input.payload.fileId ||
        Buffer.byteLength(input.payload.content) > session.config.request.maxFileBytes
      ) {
        throw new Error('Canonical publication differs from file identity or byte bound.');
      }
      break;
    }
    case 'commit-vector': {
      const input = decode(canonicalOperations['commit-vector'].input)(frame.payload);
      if (
        input.file.fileId !== input.plan.snapshot.fileId ||
        Buffer.byteLength(input.plan.snapshot.content) > session.config.request.maxFileBytes
      ) {
        throw new Error('Vector commit differs from captured file or source bound.');
      }
      break;
    }
    default:
      break;
  }
}
