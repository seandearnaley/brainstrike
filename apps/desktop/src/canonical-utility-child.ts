import type {
  CanonicalCatalogPort,
  CanonicalInferencePort,
  CanonicalOperationContext,
  CanonicalSourceInventoryPort,
  CanonicalVectorPublicationPort,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { VectorProfile } from '@brainstrike/indexer';
import { Schema } from 'effect';
import { CanonicalUtilityChannel } from './canonical-utility-channel';
import {
  CANONICAL_CHANNEL,
  type CanonicalFrame,
  type CanonicalOperation,
  type CanonicalUtilityConfig,
  canonicalFault,
  canonicalOperations,
  configSchema,
  decode,
  healthSchema,
  identifier,
  watchBatchSchema,
  watchSignalSchema,
} from './canonical-utility-protocol';

interface Runtime {
  cancel(requestId?: string): Promise<void>;
  close(): Promise<void>;
  scan?(request: object): Promise<unknown>;
  start?(): Promise<void>;
  trigger?(): void;
}
interface Session {
  acquisition?: Promise<null>;
  readonly config: CanonicalUtilityConfig;
  readonly leaseController: AbortController;
  retired?: boolean;
  runtime?: Runtime;
  scan?: { requestId: string; work: Promise<unknown>; joining: boolean } | undefined;
  stopping: boolean;
  watch?: Parameters<CanonicalWorkspaceLease['subscribe']> | undefined;
}
/** Desktop attachment lives beside the engine; @brainstrike/indexer has no product dependency. */
export class CanonicalUtilityChild {
  readonly channel: CanonicalUtilityChannel;
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  private readonly controls = new Map<number, Promise<void>>();
  constructor(private readonly send: (frame: object) => void) {
    this.channel = new CanonicalUtilityChannel(send);
  }
  receive(input: unknown): void {
    const frame = this.channel.receive(input);
    if (frame.kind === 'result') {
      return;
    }
    const session = this.sessions.get(frame.owner);
    if (frame.kind === 'event') {
      if (!session) {
        throw new Error('Canonical event has an unknown utility owner.');
      }
      if (session.stopping) {
        return;
      }
      switch (frame.event) {
        case 'watch-batch': {
          const batch = decode(watchBatchSchema)(frame.value);
          session.watch?.[0](batch.changes, batch.metadata);
          return;
        }
        case 'watch-signal':
          session.watch?.[1](decode(watchSignalSchema)(frame.value));
          return;
        case 'watch-health':
          session.watch?.[2](decode(healthSchema)(frame.value));
          return;
        default:
          throw new Error('Unknown canonical utility watch event.');
      }
    }
    if (frame.kind === 'cancel') {
      // Control cancellation stops admission; its result is sent only after physical close.
      if (!(session && this.controls.has(frame.id))) {
        throw new Error('Canonical control cancellation has no owner.');
      }
      session.stopping = true;
      session.leaseController.abort(new DOMException('Canonical control cancelled.', 'AbortError'));
      return;
    }
    if (this.controls.has(frame.id)) {
      throw new Error('Repeated canonical control request.');
    }
    const work = this.invoke(frame)
      .then(
        (value) =>
          this.send({
            channel: CANONICAL_CHANNEL,
            id: frame.id,
            kind: 'result',
            ok: true,
            owner: frame.owner,
            value,
          }),
        (error: unknown) =>
          this.send({
            channel: CANONICAL_CHANNEL,
            error: canonicalFault(error),
            id: frame.id,
            kind: 'result',
            ok: false,
            owner: frame.owner,
          })
      )
      .finally(() => this.controls.delete(frame.id));
    this.controls.set(frame.id, work);
    void work.catch((error: unknown) => {
      process.stderr.write(`${canonicalFault(error).message}\n`);
    });
  }
  private async invoke(frame: Extract<CanonicalFrame, { kind: 'call' }>): Promise<unknown> {
    if (frame.op === 'attach') {
      return this.attach(frame);
    }
    const session = this.sessions.get(frame.owner);
    if (frame.op === 'close' && session) {
      decode(Schema.Null)(frame.payload);
      await this.closeSession(frame.owner, session);
      return null;
    }
    if (!session?.runtime) {
      throw new Error('Canonical control has no acquired runtime.');
    }
    if (frame.op !== 'join-scan' && (session.stopping || this.closed)) {
      throw new Error('Canonical utility admission is closed.');
    }
    switch (frame.op) {
      case 'trigger':
        decode(Schema.Null)(frame.payload);
        if (!session.runtime.trigger) {
          throw new Error('Rootless collection has no workspace watch trigger.');
        }
        session.runtime.trigger();
        return null;
      case 'cancel':
        decode(Schema.Null)(frame.payload);
        if (session.config.scope.kind === 'collection' && !session.scan) {
          return null;
        }
        await session.runtime.cancel(session.scan?.requestId);
        return null;
      case 'start-scan':
        return this.startScan(session, frame.payload);
      case 'join-scan':
        return this.joinScan(frame.owner, session, frame.payload);
      default:
        throw new Error(`Unknown canonical utility control ${frame.op}.`);
    }
  }
  private startScan(session: Session, payload: unknown): null {
    const input = decode(Schema.Struct({ requestId: identifier }))(payload);
    const scan = session.runtime?.scan?.bind(session.runtime);
    if (session.config.scope.kind !== 'collection' || !scan || session.scan) {
      throw new Error('Canonical rootless scan is unavailable or already owned.');
    }
    const work = Promise.resolve().then(() =>
      scan({
        ...session.config.request,
        requestId: input.requestId,
        scope: session.config.scope,
      })
    );
    session.scan = { joining: false, requestId: input.requestId, work };
    // Retain the original terminal, including a failure that precedes join admission.
    void work.catch(() => {});
    return null;
  }
  private async joinScan(owner: string, session: Session, payload: unknown): Promise<unknown> {
    const input = decode(Schema.Struct({ requestId: identifier }))(payload);
    const scan = session.scan;
    if (!scan || scan.requestId !== input.requestId || scan.joining) {
      throw new Error('Canonical scan join has no matching retained owner.');
    }
    scan.joining = true;
    try {
      return await scan.work;
    } finally {
      session.scan = undefined;
      if (session.retired) {
        this.sessions.delete(owner);
      }
    }
  }
  private async attach(frame: Extract<CanonicalFrame, { kind: 'call' }>): Promise<null> {
    if (this.closed || this.sessions.has(frame.owner)) {
      throw new Error('Canonical utility attachment is closed or repeated.');
    }
    const config = decode(configSchema)(frame.payload);
    if (
      config.scope.kind === 'workspace'
        ? !config.lease || config.scope.rootId !== config.lease.rootId
        : config.lease !== null
    ) {
      throw new Error('Canonical utility scope and mounted lease disagree.');
    }
    const session: Session = { config, leaseController: new AbortController(), stopping: false };
    this.sessions.set(frame.owner, session);
    session.acquisition = this.acquireRuntime(frame.owner, session);
    return session.acquisition;
  }
  private async acquireRuntime(owner: string, session: Session): Promise<null> {
    const { config } = session;
    const publicRuntime = await import('@brainstrike/canonical-ingestion');
    if (this.closed || session.stopping) {
      throw new Error('Canonical utility closed during runtime acquisition.');
    }
    const { catalog, inference, inventory, publication } = this.ports(owner);
    const mode =
      config.mode === 'VECTOR' ? { inference, mode: 'VECTOR' as const } : { mode: 'TEXT' as const };
    if (config.scope.kind === 'workspace') {
      const lease = this.lease(owner, session);
      const dependencies: CanonicalWorkspaceRuntimeDependencies = {
        ...mode,
        catalog,
        managedCollectionId: config.managedCollectionId,
        onError: (operation, error) =>
          this.send({
            channel: CANONICAL_CHANNEL,
            event: 'error',
            kind: 'event',
            owner,
            value: { error: canonicalFault(error), operation },
          }),
        onReceipt: (receipt, sourceInvalidated) =>
          this.send({
            channel: CANONICAL_CHANNEL,
            event: sourceInvalidated ? 'source-invalidated' : 'receipt',
            kind: 'event',
            owner,
            value: receipt,
          }),
        // Main observes the same watch health directly through its captured lease.
        onWatchHealth: () => {},
        parser: config.parser,
        publication,
        request: {
          ...config.request,
          chunkingOptions: {
            ...config.request.chunkingOptions,
            separators: config.request.chunkingOptions.separators
              ? [...config.request.chunkingOptions.separators]
              : undefined,
          },
        },
        source: { indexingPolicyPreset: config.indexingPolicyPreset, inventory, lease },
      };
      const runtime = new publicRuntime.CanonicalWorkspaceIngestionRuntime(dependencies);
      session.runtime = runtime;
      await runtime.start();
    } else {
      session.runtime = new publicRuntime.CanonicalIngestionHost({
        ...mode,
        catalog,
        parser: config.parser,
        publication,
        source: new publicRuntime.CanonicalWorkspaceSource({
          indexingPolicyPreset: config.indexingPolicyPreset,
          inventory,
        }),
      });
    }
    if (session.stopping || this.closed) {
      await session.runtime.close();
      throw new Error('Canonical runtime retired during acquisition.');
    }
    return null;
  }
  private async closeSession(owner: string, session: Session): Promise<void> {
    session.stopping = true;
    session.leaseController.abort(new DOMException('Canonical mount retired.', 'AbortError'));
    // Acquisition reports its own error to the initiating caller. Retirement
    // still joins it and retains any actually acquired runtime for cleanup retry.
    await session.acquisition?.catch(() => {});
    await session.runtime?.close();
    // Close also owns a scan whose admission ACK has not reached main yet.
    // Main retains the original late-admission join to report independent failure.
    await session.scan?.work.catch(() => {});
    session.retired = true;
    if (!session.scan) {
      this.sessions.delete(owner);
    }
  }
  private async call<K extends CanonicalOperation>(
    owner: string,
    op: K,
    payload: unknown,
    context?: CanonicalOperationContext
  ): Promise<(typeof canonicalOperations)[K]['output']['Type']> {
    const operation = canonicalOperations[op];
    const projected = Schema.decodeUnknownSync(operation.input)(payload);
    return this.channel.call(
      owner,
      op,
      projected,
      operation.output,
      context?.signal,
      context?.requestId
    );
  }
  private ports(owner: string): {
    catalog: CanonicalCatalogPort<VectorProfile>;
    inference: CanonicalInferencePort<VectorProfile>;
    inventory: CanonicalSourceInventoryPort;
    publication: CanonicalVectorPublicationPort;
  } {
    const catalog: CanonicalCatalogPort<VectorProfile> = {
      applyManagedCacheBatch: async (request, context) => {
        await this.call(owner, 'apply-cache', request, context);
      },
      completeFiles: async (request, context) => {
        await this.call(owner, 'complete-files', request, context);
      },
      loadAuthorizedBatch: (request, context) =>
        this.call(owner, 'load-authorized', request, context),
      prepareManagedSourcesBatch: (request, context) =>
        this.call(owner, 'prepare-sources', request, context),
      removeFiles: async (request, context) => {
        await this.call(owner, 'remove-files', request, context);
      },
      resolveProfile: (request, context) => this.call(owner, 'resolve-profile', request, context),
    };
    const inventory: CanonicalSourceInventoryPort = {
      loadFiles: (scope, context) => this.call(owner, 'load-files', scope, context),
      readRetained: (file, maxFileBytes, context) =>
        this.call(owner, 'read-retained', { file, maxFileBytes }, context),
    };
    const publication: CanonicalVectorPublicationPort = {
      abortScan: async (ticket) => {
        await this.call(owner, 'abort-scan', ticket);
      },
      beginScan: (request) => this.call(owner, 'begin-scan', request),
      commitTextFile: async (request) => {
        await this.call(owner, 'commit-text', request);
      },
      commitVectorFile: async (request) => {
        await this.call(owner, 'commit-vector', request);
      },
      finishScan: (request) => this.call(owner, 'finish-scan', request),
      prepareVectorFile: (request) => this.call(owner, 'prepare-vector', request),
      removeFile: async (request) => {
        await this.call(owner, 'remove-file', request);
      },
      vectorCoverage: (request) => this.call(owner, 'vector-coverage', request),
      verifyManifest: (request) => this.call(owner, 'verify-manifest', request),
      verifyVectorManifest: (request) => this.call(owner, 'verify-vector-manifest', request),
    };
    const inference: CanonicalInferencePort<VectorProfile> = {
      cancel: async (requestId) => {
        await this.call(owner, 'inference-cancel', { requestId });
      },
      generate: (request) => this.call(owner, 'inference-generate', request),
      join: async (requestId) => {
        await this.call(owner, 'inference-join', { requestId });
      },
    };
    return { catalog, inference, inventory, publication };
  }
  private lease(owner: string, session: Session): CanonicalWorkspaceLease {
    const { lease } = session.config;
    if (!lease) {
      throw new Error('Canonical workspace requires an actual captured lease.');
    }
    return {
      ...lease,
      listDir: (relativePath, maxEntries, context) =>
        this.call(owner, 'list-dir', { maxEntries, relativePath }, context),
      readFile: async (relativePath, maxBytes, context) => {
        const result = await this.call(owner, 'read-file', { maxBytes, relativePath }, context);
        if (result.status !== 'ok') {
          return result;
        }
        const bytes = Buffer.from(result.content, 'base64');
        if (bytes.byteLength > maxBytes || bytes.toString('base64') !== result.content) {
          throw new Error('Canonical mounted read returned invalid or oversized bytes.');
        }
        return { content: bytes, status: 'ok' };
      },
      retire: async () => {
        await this.call(owner, 'retire-lease', null);
      },
      signal: session.leaseController.signal,
      subscribe: async (...watch) => {
        session.watch = watch;
        await this.call(owner, 'subscribe', null, watch[3]);
        return {
          close: async () => {
            await this.call(owner, 'unsubscribe', null);
            session.watch = undefined;
          },
        };
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.sessions].map(([owner, session]) => this.closeSession(owner, session))
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical utility runtimes remain owned.');
    }
  }
}
