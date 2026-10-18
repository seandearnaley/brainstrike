import { randomUUID } from 'node:crypto';
import type { CanonicalOperationContext } from '@brainstrike/canonical-ingestion';
import { Schema } from 'effect';
import {
  assertDiscoveredSource,
  assertMode,
  assertVectorManifestAuthority,
  type CanonicalCollectionDependencies,
  type CanonicalRemoteWorkspaceDependencies,
  capturedAuthority,
  isOwnedCleanup,
  recheckCallbackAuthority,
  type Session,
  sameScope,
} from './canonical-utility-authority';
import { CanonicalUtilityChannel } from './canonical-utility-channel';
import {
  CANONICAL_CHANNEL,
  type CanonicalFrame,
  type CanonicalUtilityConfig,
  canonicalError,
  canonicalFault,
  canonicalOperations,
  configSchema,
  decode,
  faultSchema,
  receiptSchema,
} from './canonical-utility-protocol';
import { assertCanonicalRequest } from './canonical-utility-request-authority';
import { NativeAuthorityTransitionError } from './native-authority-transition';

export type {
  CanonicalCollectionDependencies,
  CanonicalRemoteIngestion,
  CanonicalRemoteWorkspaceDependencies,
} from './canonical-utility-authority';
export interface CanonicalWorkspaceAttachment {
  cancel(): Promise<void>;
  close(): Promise<void>;
  trigger(): Promise<void>;
}
export interface CanonicalCollectionAttachment {
  cancel(): Promise<void>;
  close(): Promise<void>;
  scan(requestId: string): Promise<typeof receiptSchema.Type>;
}
export interface CanonicalCollectionScan {
  join(): Promise<typeof receiptSchema.Type>;
}
export interface CanonicalCollectionOwner extends CanonicalCollectionAttachment {
  startScan(requestId: string): Promise<CanonicalCollectionScan>;
}
/** Main retains actual capability objects. A child owner token selects only this captured closure. */
export class CanonicalUtilityParent {
  private readonly sessions = new Map<string, Session>();
  private readonly acquisitions = new Map<string, Promise<unknown>>();
  private closed = false;
  private retiringAttachments = false;
  private attachmentRetirement: Promise<void> | undefined;
  private remoteExited = false;
  /** The first exit's error: what an attachment the exit ended reports instead of a close. */
  private remoteExit: unknown;
  readonly channel: CanonicalUtilityChannel;
  constructor(
    private readonly send: (frame: object) => void,
    private readonly onTransportFailure: (error: unknown) => void
  ) {
    this.channel = new CanonicalUtilityChannel(send);
  }

  async attachWorkspace(
    dependencies: CanonicalRemoteWorkspaceDependencies
  ): Promise<CanonicalWorkspaceAttachment> {
    assertMode(dependencies);
    const lease = dependencies.source.lease;
    lease.signal.throwIfAborted();
    const config = decode(configSchema)({
      indexingPolicyPreset: dependencies.source.indexingPolicyPreset,
      lease: {
        canonicalPath: lease.canonicalPath,
        generation: lease.generation,
        rootId: lease.rootId,
      },
      managedCollectionId: dependencies.managedCollectionId,
      mode: dependencies.mode ?? 'TEXT',
      parser: dependencies.parser,
      request: dependencies.request,
      scope: { kind: 'workspace', rootId: lease.rootId },
    });
    const owner = await this.attach(config, dependencies);
    const revoke = (): void => {
      void this.closeOwner(owner).catch((error: unknown) =>
        dependencies.onError('utility mount retirement', error)
      );
    };
    lease.signal.addEventListener('abort', revoke, { once: true });
    if (lease.signal.aborted) {
      revoke();
    }
    return {
      cancel: () => this.control(owner, 'cancel'),
      close: async () => {
        await this.closeOwner(owner);
        lease.signal.removeEventListener('abort', revoke);
      },
      trigger: () => this.control(owner, 'trigger'),
    };
  }

  async attachCollection(
    dependencies: CanonicalCollectionDependencies
  ): Promise<CanonicalCollectionOwner> {
    assertMode(dependencies);
    const config = decode(configSchema)({
      indexingPolicyPreset: dependencies.source.indexingPolicyPreset,
      lease: null,
      managedCollectionId: dependencies.scope.embeddingSetId,
      mode: dependencies.mode ?? 'TEXT',
      parser: dependencies.parser,
      request: dependencies.request,
      scope: dependencies.scope,
    });
    const owner = await this.attach(config, dependencies);
    const startScan = async (requestId: string): Promise<CanonicalCollectionScan> => {
      const session = this.sessions.get(owner);
      if (this.closed || this.retiringAttachments || !session || session.stopping) {
        throw new Error('Canonical utility scan admission is closed.');
      }
      await this.channel.call(owner, 'start-scan', { requestId }, Schema.Null);
      let terminal: Promise<typeof receiptSchema.Type> | undefined;
      return {
        join: () => {
          terminal ??= this.channel.call(owner, 'join-scan', { requestId }, receiptSchema);
          return terminal;
        },
      };
    };
    return {
      cancel: () => this.control(owner, 'cancel'),
      close: () => this.closeOwner(owner),
      scan: async (requestId) => (await startScan(requestId)).join(),
      startScan,
    };
  }

  private async attach(
    config: CanonicalUtilityConfig,
    dependencies: Session['dependencies']
  ): Promise<string> {
    if (this.closed) {
      throw new Error('Canonical utility admission is closed.');
    }
    if (this.retiringAttachments) {
      throw new Error('Canonical utility attachment retirement owns admission.');
    }
    for (const session of this.sessions.values()) {
      if (sameScope(session.config.scope, config.scope)) {
        throw new Error('Canonical utility scope already has an owner.');
      }
    }
    const owner = randomUUID();
    this.sessions.set(owner, {
      catalog: dependencies.catalog,
      childClosed: false,
      config,
      dependencies,
      files: new Map(),
      inference: dependencies.mode === 'VECTOR' ? dependencies.inference : undefined,
      inferenceRequests: new Set(),
      inventory: dependencies.source.inventory,
      lastRequestId: 0,
      lease: 'lease' in dependencies.source ? dependencies.source.lease : undefined,
      pending: new Map(),
      publication: dependencies.publication,
      stopping: false,
      subscriptionAcquired: false,
      transportErrors: new Set(),
      usedInferenceRequests: new Set(),
      vectorPublication: dependencies.mode === 'VECTOR' ? dependencies.publication : undefined,
    });
    // A failed acquisition retains the owner; close() is the explicit retry path.
    const acquisition = this.channel.call(owner, 'attach', config, Schema.Null);
    this.acquisitions.set(owner, acquisition);
    await acquisition;
    if (this.closed || this.retiringAttachments || !this.sessions.has(owner)) {
      throw new Error('Canonical utility attachment retired during acquisition.');
    }
    return owner;
  }

  receive(input: unknown): void {
    const frame = this.channel.receive(input);
    if (frame.kind === 'result') {
      return;
    }
    const session = this.sessions.get(frame.owner);
    if (!session) {
      throw new Error('Canonical utility request has an unknown captured owner.');
    }
    if (frame.kind === 'event') {
      this.event(session, frame);
      return;
    }
    if (frame.kind === 'cancel') {
      const pending = session.pending.get(frame.id);
      if (!pending) {
        if (frame.id <= session.lastRequestId) {
          return;
        }
        throw new Error('Canonical utility cancellation has an unknown request.');
      }
      pending.controller.abort(
        new DOMException('Canonical remote request cancelled.', 'AbortError')
      );
      return;
    }
    if (frame.id <= session.lastRequestId || session.pending.size >= 64) {
      throw new Error('Canonical utility request is repeated or exceeds its pending bound.');
    }
    session.lastRequestId = frame.id;
    if (session.stopping && !isOwnedCleanup(frame)) {
      this.refuseStoppedRequest(session, frame);
      return;
    }
    const controller = new AbortController();
    const pending = { controller, settled: Promise.resolve() };
    session.pending.set(frame.id, pending);
    pending.settled = this.invoke(session, frame, controller)
      .then(
        (value) => this.respond(frame, true, value),
        (error: unknown) => {
          // Main revokes the native authority in the same turn that its retirement
          // stops this request, so admitted work fails on that revocation instead of
          // the cancellation reason; it is the same cancellation (BST-1955). An
          // independent failure, and a cleanup the retirement still owns, stay visible.
          const revoked =
            controller.signal.aborted &&
            error instanceof NativeAuthorityTransitionError &&
            !isOwnedCleanup(frame);
          if (revoked || error === controller.signal.reason) {
            this.respond(frame, false, controller.signal.reason, true);
            return;
          }
          this.respond(frame, false, error);
        }
      )
      .finally(() => session.pending.delete(frame.id));
    // Sending a terminal response may fail after physical work; preserve it in the join.
    void pending.settled.catch(() => {});
  }

  private refuseStoppedRequest(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>
  ): void {
    try {
      assertCanonicalRequest(session, frame);
    } catch (error) {
      this.respond(frame, false, error);
      return;
    }
    this.respond(frame, false, new Error('Canonical source admission is closed.'), true);
  }
  private respond(
    frame: Extract<CanonicalFrame, { kind: 'call' }>,
    ok: boolean,
    value: unknown,
    cancelled = false
  ): void {
    if (this.remoteExited) {
      return;
    }
    const session = this.sessions.get(frame.owner);
    if (!session) {
      throw new Error('Canonical terminal response lost its retained owner.');
    }
    this.sendOwned(
      session,
      ok
        ? {
            channel: CANONICAL_CHANNEL,
            id: frame.id,
            kind: 'result',
            ok: true,
            owner: frame.owner,
            value,
          }
        : {
            channel: CANONICAL_CHANNEL,
            error: canonicalFault(value),
            ...(cancelled ? { cancelled: true as const } : {}),
            id: frame.id,
            kind: 'result',
            ok: false,
            owner: frame.owner,
          }
    );
  }
  private sendOwned(session: Session, frame: object): void {
    try {
      this.send(frame);
    } catch (error) {
      session.transportErrors.add(error);
      for (const owned of this.sessions.values()) {
        this.stop(owned);
      }
      this.onTransportFailure(error);
      throw error;
    }
  }
  private async control(owner: string, op: string): Promise<void> {
    await this.channel.call(owner, op, null, Schema.Null);
  }
  private stop(session: Session): void {
    session.stopping = true;
    for (const pending of session.pending.values()) {
      pending.controller.abort(new DOMException('Canonical attachment retired.', 'AbortError'));
    }
  }
  closeOwner(owner: string): Promise<void> {
    const session = this.sessions.get(owner);
    if (!session) {
      return Promise.resolve();
    }
    this.stop(session);
    session.close ??= (async () => {
      const errors: unknown[] = [];
      let exit: { readonly error: unknown } | undefined;
      if (!session.childClosed) {
        try {
          await this.control(owner, 'close');
          session.childClosed = true;
        } catch (error) {
          // An exited utility cannot close its attachment: the exit ended it, unretired
          // (BST-2135). Main's own capabilities still join below.
          if (this.remoteExited) {
            exit = { error: this.remoteExit };
          } else {
            errors.push(error);
          }
        }
      }
      // Join the original acquisition even if a close response arrives before its response.
      await this.acquisitions.get(owner)?.catch(() => undefined);
      try {
        await this.join(session);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Canonical attachment retirement remains owned.');
      }
      if (exit) {
        throw exit.error;
      }
      this.sessions.delete(owner);
      this.acquisitions.delete(owner);
    })().finally(() => {
      session.close = undefined;
    });
    return session.close;
  }
  close(): Promise<void> {
    if (this.remoteExited) {
      return this.exited(new Error('Canonical remote exit already joined.'));
    }
    this.closed = true;
    for (const session of this.sessions.values()) {
      this.stop(session);
    }
    return this.closeAll();
  }
  /** Join source owners without retiring this parent or the utility's native reader/writer. */
  retireAttachments(): Promise<void> {
    this.retiringAttachments = true;
    for (const session of this.sessions.values()) {
      this.stop(session);
    }
    this.attachmentRetirement ??= this.closeAll()
      .then(() => {
        this.retiringAttachments = false;
      })
      .finally(() => {
        this.attachmentRetirement = undefined;
      });
    return this.attachmentRetirement;
  }
  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((owner) => this.closeOwner(owner))
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical utility attachments remain owned.');
    }
  }
  /** Remote process exit does not retire main's outstanding filesystem/watch work. */
  async exited(error: unknown): Promise<void> {
    this.closed = true;
    this.remoteExited = true;
    this.remoteExit ??= error;
    for (const session of this.sessions.values()) {
      this.stop(session);
    }
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.join(session))
    );
    this.channel.fail(error);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical utility exited with retained main cleanup.');
    }
    this.sessions.clear();
    this.acquisitions.clear();
  }
  private async join(session: Session): Promise<void> {
    const inferenceErrors = await this.retireInference(session);
    const results = await Promise.allSettled(
      [...session.pending.values()].map((pending) => pending.settled)
    );
    const errors = [
      ...new Set([
        ...session.transportErrors,
        ...inferenceErrors,
        ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ]),
    ];
    session.transportErrors.clear();
    try {
      await session.subscription?.close();
      session.subscription = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      await session.lease?.retire();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical main capability retirement failed.');
    }
  }
  private async retireInference(session: Session): Promise<unknown[]> {
    const inference = session.inference;
    if (!inference) {
      return [];
    }
    const results = await Promise.allSettled(
      [...session.inferenceRequests].map(async (requestId) => {
        const errors: unknown[] = [];
        try {
          await inference.cancel(requestId);
        } catch (error) {
          errors.push(error);
        }
        try {
          await inference.join(requestId);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Canonical inference retirement remains owned.');
        }
        session.inferenceRequests.delete(requestId);
      })
    );
    return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  }

  private event(session: Session, frame: Extract<CanonicalFrame, { kind: 'event' }>): void {
    if (!('onReceipt' in session.dependencies)) {
      throw new Error('Rootless host cannot emit workspace events.');
    }
    if (session.stopping) {
      return;
    }
    switch (frame.event) {
      case 'source-invalidated': {
        const receipt = decode(receiptSchema)(frame.value);
        if (
          receipt.scanComplete ||
          receipt.reason !== 'manifest-mismatch' ||
          receipt.ticket.scope.kind !== 'workspace' ||
          !sameScope(receipt.ticket.scope, session.config.scope)
        ) {
          throw new Error('Canonical source invalidation differs from its captured workspace.');
        }
        session.dependencies.onReceipt(receipt, true);
        return;
      }
      case 'receipt':
        session.dependencies.onReceipt(decode(receiptSchema)(frame.value));
        return;
      case 'error': {
        const value = decode(Schema.Struct({ error: faultSchema, operation: Schema.String }))(
          frame.value
        );
        session.dependencies.onError(value.operation, canonicalError(value.error));
        return;
      }
      default:
        throw new Error('Unknown canonical utility event.');
    }
  }

  private async invoke(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>,
    controller: AbortController
  ): Promise<unknown> {
    const context: CanonicalOperationContext = {
      requestId: frame.requestId ?? `utility:${frame.id}`,
      signal: controller.signal,
    };
    assertCanonicalRequest(session, frame);
    const authority = capturedAuthority(session, frame);
    const leaseOperations = ['list-dir', 'read-file', 'subscribe', 'unsubscribe', 'retire-lease'];
    const catalogOperations = [
      'load-files',
      'read-retained',
      'load-authorized',
      'prepare-sources',
      'apply-cache',
      'complete-files',
      'remove-files',
      'resolve-profile',
    ];
    const value = frame.op.startsWith('inference-')
      ? await this.invokeInference(session, frame)
      : ['prepare-vector', 'commit-vector', 'verify-vector-manifest', 'vector-coverage'].includes(
            frame.op
          )
        ? await this.invokeVector(session, frame, authority)
        : leaseOperations.includes(frame.op)
          ? await this.invokeLease(session, frame, context, authority)
          : catalogOperations.includes(frame.op)
            ? await this.invokeCatalog(session, frame, context, authority)
            : await this.invokePublication(session, frame, authority);
    if (!isOwnedCleanup(frame)) {
      context.signal.throwIfAborted();
      if (session.stopping) {
        throw new DOMException('Canonical attachment retired.', 'AbortError');
      }
      authority.lease?.signal.throwIfAborted();
    }
    recheckCallbackAuthority(session, frame);
    const operation = canonicalOperations[frame.op as keyof typeof canonicalOperations];
    return Schema.decodeUnknownSync(operation.output)(value);
  }

  private async invokeLease(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>,
    context: CanonicalOperationContext,
    authority: ReturnType<typeof capturedAuthority>
  ): Promise<unknown> {
    const { dependencies: deps } = session;
    const { ownedLease, lease } = authority;
    let value: unknown;
    switch (frame.op) {
      case 'list-dir': {
        const input = decode(canonicalOperations['list-dir'].input)(frame.payload);
        value = await ownedLease().listDir(input.relativePath, input.maxEntries, context);
        break;
      }
      case 'read-file': {
        const input = decode(canonicalOperations['read-file'].input)(frame.payload);
        const read = await ownedLease().readFile(input.relativePath, input.maxBytes, context);
        if (read.status === 'ok' && read.content.byteLength > input.maxBytes) {
          throw new Error('Mounted read exceeded its captured byte bound.');
        }
        value =
          read.status === 'ok'
            ? { content: Buffer.from(read.content).toString('base64'), status: 'ok' }
            : read;
        break;
      }
      case 'subscribe': {
        decode(Schema.Null)(frame.payload);
        session.subscriptionAcquired = true;
        const event = (event: string, value: unknown): void => {
          if (!(session.stopping || context.signal.aborted)) {
            this.sendOwned(session, {
              channel: CANONICAL_CHANNEL,
              event,
              kind: 'event',
              owner: frame.owner,
              value,
            });
          }
        };
        session.subscription = await ownedLease().subscribe(
          (changes, metadata) =>
            event('watch-batch', { changes, ...(metadata ? { metadata } : {}) }),
          (signal) => event('watch-signal', signal),
          (health) => {
            event('watch-health', health);
            if ('onWatchHealth' in deps) {
              deps.onWatchHealth(health);
            }
          },
          context
        );
        value = null;
        break;
      }
      case 'unsubscribe':
        decode(Schema.Null)(frame.payload);
        await session.subscription?.close();
        session.subscription = undefined;
        value = null;
        break;
      case 'retire-lease':
        decode(Schema.Null)(frame.payload);
        await lease?.retire();
        value = null;
        break;
      default:
        throw new Error(`Unknown canonical callback ${frame.op}.`);
    }
    return value;
  }

  private async invokeCatalog(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>,
    context: CanonicalOperationContext,
    authority: ReturnType<typeof capturedAuthority>
  ): Promise<unknown> {
    const { catalog, config } = session;
    const { scope, files, remember } = authority;
    let value: unknown;
    switch (frame.op) {
      case 'load-files': {
        const input = decode(canonicalOperations['load-files'].input)(frame.payload);
        scope(input);
        const result = await session.inventory.loadFiles(config.scope, context);
        remember(result);
        value = result;
        break;
      }
      case 'read-retained': {
        const input = decode(canonicalOperations['read-retained'].input)(frame.payload);
        files([input.file]);
        value = await session.inventory.readRetained(input.file, input.maxFileBytes, context);
        break;
      }
      case 'load-authorized': {
        const input = decode(canonicalOperations['load-authorized'].input)(frame.payload);
        scope(input.scope);
        files(input.files);
        const result = await catalog.loadAuthorizedBatch(input, context);
        files(input.files);
        remember(result);
        value = result;
        break;
      }
      case 'prepare-sources': {
        const input = decode(canonicalOperations['prepare-sources'].input)(frame.payload);
        scope(input.scope);
        if (input.scope.kind !== 'workspace') {
          throw new Error('Discovered batch has no captured workspace authority.');
        }
        for (const file of input.files) {
          assertDiscoveredSource(file, config);
        }
        const result = await catalog.prepareManagedSourcesBatch(
          { files: input.files, scope: input.scope },
          context
        );
        remember(result);
        value = result;
        break;
      }
      case 'apply-cache': {
        const input = decode(canonicalOperations['apply-cache'].input)(frame.payload);
        scope(input.scope);
        files(input.files);
        await catalog.applyManagedCacheBatch(input, context);
        value = null;
        break;
      }
      case 'complete-files': {
        const input = decode(canonicalOperations['complete-files'].input)(frame.payload);
        scope(input.scope);
        await catalog.completeFiles(input, context);
        value = null;
        break;
      }
      case 'remove-files': {
        const input = decode(canonicalOperations['remove-files'].input)(frame.payload);
        scope(input.scope);
        files(input.files);
        await catalog.removeFiles(input, context);
        value = null;
        break;
      }
      case 'resolve-profile': {
        const input = decode(canonicalOperations['resolve-profile'].input)(frame.payload);
        scope(input.scope);
        value = await catalog.resolveProfile(input, context);
        break;
      }
      default:
        throw new Error(`Unknown canonical callback ${frame.op}.`);
    }
    return value;
  }
  private async invokeInference(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>
  ): Promise<unknown> {
    const inference = session.inference;
    if (!inference) {
      throw new Error('Inference requires explicit captured VECTOR dependencies.');
    }
    if (frame.op === 'inference-generate') {
      const input = decode(canonicalOperations['inference-generate'].input)(frame.payload);
      session.usedInferenceRequests.add(input.requestId);
      session.inferenceRequests.add(input.requestId);
      return await inference.generate(input);
    }
    const input = decode(canonicalOperations['inference-cancel'].input)(frame.payload);
    if (!session.usedInferenceRequests.has(input.requestId)) {
      throw new Error('Canonical inference operation has no captured owner.');
    }
    switch (frame.op) {
      case 'inference-cancel':
        if (session.inferenceRequests.has(input.requestId)) {
          await inference.cancel(input.requestId);
        }
        return null;
      case 'inference-join':
        if (session.inferenceRequests.has(input.requestId)) {
          await inference.join(input.requestId);
        }
        session.inferenceRequests.delete(input.requestId);
        return null;
      default:
        throw new Error(`Unknown canonical inference callback ${frame.op}.`);
    }
  }
  private async invokeVector(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>,
    authority: ReturnType<typeof capturedAuthority>
  ): Promise<unknown> {
    const publication = session.vectorPublication;
    if (!publication) {
      throw new Error('Vector publication requires explicit captured VECTOR dependencies.');
    }
    const { scope, files } = authority;
    switch (frame.op) {
      case 'prepare-vector': {
        const input = decode(canonicalOperations['prepare-vector'].input)(frame.payload);
        scope(input.ticket.scope);
        files([input.file]);
        return await publication.prepareVectorFile(input);
      }
      case 'commit-vector': {
        const input = decode(canonicalOperations['commit-vector'].input)(frame.payload);
        scope(input.ticket.scope);
        files([input.file]);
        await publication.commitVectorFile(input);
        return null;
      }
      case 'verify-vector-manifest': {
        const input = decode(canonicalOperations['verify-vector-manifest'].input)(frame.payload);
        scope(input.scope);
        assertVectorManifestAuthority(session, authority, input.files);
        return await publication.verifyVectorManifest(input);
      }
      case 'vector-coverage': {
        const input = decode(canonicalOperations['vector-coverage'].input)(frame.payload);
        scope(input.scope);
        return await publication.vectorCoverage(input);
      }
      default:
        throw new Error(`Unknown canonical vector callback ${frame.op}.`);
    }
  }

  private async invokePublication(
    session: Session,
    frame: Extract<CanonicalFrame, { kind: 'call' }>,
    authority: ReturnType<typeof capturedAuthority>
  ): Promise<unknown> {
    const { publication } = session;
    const { scope, files } = authority;
    let value: unknown;
    switch (frame.op) {
      case 'begin-scan': {
        const input = decode(canonicalOperations['begin-scan'].input)(frame.payload);
        scope(input.scope);
        value = await publication.beginScan(input);
        break;
      }
      case 'abort-scan': {
        const input = decode(canonicalOperations['abort-scan'].input)(frame.payload);
        scope(input.scope);
        await publication.abortScan(input);
        value = null;
        break;
      }
      case 'commit-text': {
        const input = decode(canonicalOperations['commit-text'].input)(frame.payload);
        scope(input.ticket.scope);
        files([input.file]);
        await publication.commitTextFile(input);
        value = null;
        break;
      }
      case 'finish-scan': {
        const input = decode(canonicalOperations['finish-scan'].input)(frame.payload);
        scope(input.ticket.scope);
        files(input.files, false);
        const receipt = await publication.finishScan(input);
        if (isOwnedCleanup(frame) && receipt.scanComplete) {
          throw new Error('Owned retirement cannot publish a complete scan receipt.');
        }
        value = receipt;
        break;
      }
      case 'remove-file': {
        const input = decode(canonicalOperations['remove-file'].input)(frame.payload);
        scope(input.ticket.scope);
        files([input.file]);
        await publication.removeFile(input);
        value = null;
        break;
      }
      case 'verify-manifest': {
        const input = decode(canonicalOperations['verify-manifest'].input)(frame.payload);
        scope(input.scope);
        files(input.files, false);
        value = await publication.verifyManifest(input);
        break;
      }
      default:
        throw new Error(`Unknown canonical callback ${frame.op}.`);
    }
    return value;
  }
}
