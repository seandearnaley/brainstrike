import { isDeepStrictEqual } from 'node:util';
import {
  type ConfiguredMcpServerId,
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostControlRequest,
  type McpHostError,
  type McpHostInvokeOptions,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  type McpHostWatchEvent,
  type McpHostWatchFilter,
  parseMcpHostConfig,
  parseMcpHostControlRequest,
  parseMcpHostOperation,
} from '@brainstrike/assistant-contract';
import type { McpHostRevisionPublisher } from './host-revision-publisher';
import { settleOnAbort } from './server-actor';

type ConfiguredServer = McpHostConfig['servers'][number];
type Counter = Exclude<keyof McpHostCloseReport, 'failures'>;
const COUNTER_KEYS = {
  callbacksClosed: true,
  childProcessesClosed: true,
  clientsClosed: true,
  loopbackPortsClosed: true,
  probesClosed: true,
  requestsSettled: true,
  subscriptionsClosed: true,
} satisfies Record<Counter, true>;
const COUNTERS = Object.keys(COUNTER_KEYS) as readonly Counter[];
export interface McpHostActor extends Pick<McpHostPort, 'close' | 'invoke'> {
  cancel(): Promise<McpHostServerSnapshot>;
  connect(): Promise<McpHostServerSnapshot>;
  disconnect(): Promise<McpHostServerSnapshot>;
  invalidated(): boolean;
  snapshot(): McpHostServerSnapshot;
}
export interface McpHostActorFactoryInput {
  config: ConfiguredServer;
  generation: number;
  onSnapshotChanged(snapshot: McpHostServerSnapshot): void;
}
export type McpHostActorFactory = (input: McpHostActorFactoryInput) => McpHostActor;
interface ActorEntry {
  actor: McpHostActor;
  config: ConfiguredServer;
}
interface McpHostServiceOptions {
  actorFactory: McpHostActorFactory;
  onInternalError(code: McpHostServiceInternalErrorCode, cause: unknown): Promise<void> | void;
  publisher: McpHostRevisionPublisher;
}
export type McpHostServiceInternalErrorCode =
  | 'mcp-host-actor-close-failed'
  | 'mcp-host-actor-create-failed'
  | 'mcp-host-actor-snapshot-failed'
  | 'mcp-host-publish-failed'
  | 'mcp-host-unpublished-actor-transition';
type McpHostServiceErrorCode =
  | 'mcp-host-actor-create-failed'
  | 'mcp-host-actor-snapshot-failed'
  | 'mcp-host-closed'
  | 'mcp-host-publish-failed'
  | 'mcp-host-reauthorize-requires-oauth'
  | 'mcp-host-replacement-cleanup-failed'
  | 'mcp-host-server-unknown';
const SERVICE_ERROR_MESSAGES = {
  'mcp-host-actor-create-failed': 'MCP host actor creation failed',
  'mcp-host-actor-snapshot-failed': 'MCP host actor snapshot failed',
  'mcp-host-closed': 'MCP host is closed',
  'mcp-host-publish-failed': 'MCP host authority publication failed',
  'mcp-host-reauthorize-requires-oauth': 'MCP reauthorization requires oauth-user authentication',
  'mcp-host-replacement-cleanup-failed': 'MCP host replacement cleanup failed',
  'mcp-host-server-unknown': 'MCP host server is not configured',
} satisfies Record<McpHostServiceErrorCode, string>;
export class McpHostServiceError extends Error {
  readonly category: 'configuration' | 'host-closed' | 'transport';
  constructor(
    readonly code: McpHostServiceErrorCode,
    readonly report?: McpHostCloseReport
  ) {
    super(SERVICE_ERROR_MESSAGES[code]);
    this.name = 'McpHostServiceError';
    this.category =
      code === 'mcp-host-closed'
        ? 'host-closed'
        : code === 'mcp-host-server-unknown' || code === 'mcp-host-reauthorize-requires-oauth'
          ? 'configuration'
          : 'transport';
  }
}
function freezeReport(reports: readonly McpHostCloseReport[]): McpHostCloseReport {
  const aggregate = Object.fromEntries(COUNTERS.map((counter) => [counter, 0])) as Record<
    Counter,
    number
  >;
  const failures: McpHostError[] = [];
  let overflow = false;
  for (const report of reports) {
    for (const counter of COUNTERS) {
      const next = aggregate[counter] + report[counter];
      const safe = Number.isSafeInteger(next);
      aggregate[counter] = safe ? next : Number.MAX_SAFE_INTEGER;
      overflow ||= !safe;
    }
    failures.push(...report.failures);
  }
  if (overflow) {
    failures.push(CLOSE_COUNTER_OVERFLOW);
  }
  return Object.freeze({
    ...aggregate,
    failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
  });
}
const EMPTY_COUNTERS = Object.fromEntries(COUNTERS.map((counter) => [counter, 0])) as Readonly<
  Record<Counter, number>
>;
const ACTOR_CLOSE_FAILURE = Object.freeze({
  category: 'transport',
  code: 'mcp-host-actor-close-failed',
  message: 'MCP host operation failed',
} as const);
const CLOSE_COUNTER_OVERFLOW = Object.freeze({
  category: 'transport',
  code: 'mcp-host-close-counter-overflow',
  message: 'MCP host operation failed',
} as const);
const failedCloseReport = (): McpHostCloseReport =>
  freezeReport([{ ...EMPTY_COUNTERS, failures: [ACTOR_CLOSE_FAILURE] }]);
const closedSubscriptionsReport = (subscriptionsClosed: number): McpHostCloseReport =>
  freezeReport([{ ...EMPTY_COUNTERS, failures: [], subscriptionsClosed }]);
const failedAuthorityReconciliationReport = (
  code: 'mcp-host-actor-snapshot-failed' | 'mcp-host-publish-failed'
): McpHostCloseReport =>
  freezeReport([
    {
      ...EMPTY_COUNTERS,
      failures: [{ category: 'transport', code, message: 'MCP host operation failed' }],
    },
  ]);
export class McpHostService implements McpHostPort {
  private actors = new Map<ConfiguredMcpServerId, ActorEntry>();
  private readonly closeWork = new Map<McpHostActor, Promise<McpHostCloseReport>>();
  private closePromise: Promise<McpHostCloseReport> | undefined;
  private readonly generations = new Map<ConfiguredMcpServerId, number>();
  private readonly ownedActors = new Set<McpHostActor>();
  private readonly recordedActors = new WeakSet<McpHostActor>();
  private retiredReport = freezeReport([]);
  private pendingReplacements = 0;
  private replacementFailure: McpHostCloseReport | undefined;
  private replacementTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: McpHostServiceOptions) {}
  snapshot(): McpHostSnapshot {
    return this.options.publisher.snapshot();
  }
  retiredCleanupReport(): McpHostCloseReport {
    return freezeReport([this.retiredReport]);
  }
  invoke(
    operation: McpHostOperation,
    options?: McpHostInvokeOptions
  ): Promise<McpHostOperationResult> {
    let parsedOperation: McpHostOperation;
    try {
      parsedOperation = parseMcpHostOperation(operation);
    } catch (cause) {
      return Promise.reject(cause);
    }
    if (this.closePromise) {
      return Promise.reject(new McpHostServiceError('mcp-host-closed'));
    }
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }
    const getEntry = (): ActorEntry => {
      this.assertOpen();
      const entry = this.actors.get(parsedOperation.configuredServerId);
      if (!entry) {
        throw new McpHostServiceError('mcp-host-server-unknown');
      }
      return entry;
    };
    const invokeCurrent = (): Promise<McpHostOperationResult> => {
      options?.signal?.throwIfAborted();
      return getEntry().actor.invoke(parsedOperation, options);
    };
    const invokeWithSelfHeal = (): Promise<McpHostOperationResult> => {
      if (getEntry().actor.invalidated()) {
        return this.enqueueReplacement(
          this.currentConfig(),
          parsedOperation.configuredServerId
        ).then(invokeCurrent);
      }
      return invokeCurrent();
    };
    try {
      const work =
        this.pendingReplacements === 0
          ? invokeWithSelfHeal()
          : this.replacementTail.then(invokeWithSelfHeal);
      return options?.signal ? settleOnAbort(work, options.signal) : work;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  replaceConfig(config: McpHostConfig): Promise<McpHostSnapshot> {
    if (this.closePromise) {
      return Promise.reject(new McpHostServiceError('mcp-host-closed'));
    }
    let parsed: McpHostConfig;
    try {
      parsed = parseMcpHostConfig(config);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.enqueueReplacement(parsed);
  }
  control(request: McpHostControlRequest): Promise<McpHostServerSnapshot> {
    let parsedRequest: McpHostControlRequest;
    try {
      parsedRequest = parseMcpHostControlRequest(request);
    } catch (cause) {
      return Promise.reject(cause);
    }
    if (this.closePromise) {
      return Promise.reject(new McpHostServiceError('mcp-host-closed'));
    }
    if (parsedRequest.action === 'cancel' || parsedRequest.action === 'connect') {
      const current = this.actors.get(parsedRequest.configuredServerId);
      if (!current) {
        return Promise.reject(new McpHostServiceError('mcp-host-server-unknown'));
      }
      return parsedRequest.action === 'cancel' ? current.actor.cancel() : current.actor.connect();
    }
    return this.enqueueSerialized(async () => {
      const currentConfig = this.currentConfig();
      const configuredServer = currentConfig.servers.find(
        ({ configuredServerId }) => configuredServerId === parsedRequest.configuredServerId
      );
      if (!configuredServer) {
        throw new McpHostServiceError('mcp-host-server-unknown');
      }
      if (parsedRequest.action === 'disconnect' || parsedRequest.action === 'reauthorize') {
        if (parsedRequest.action === 'reauthorize' && configuredServer.auth.type !== 'oauth-user') {
          throw new McpHostServiceError('mcp-host-reauthorize-requires-oauth');
        }
        await this.getActor(parsedRequest.configuredServerId).disconnect();
        await this.applyConfig(currentConfig, parsedRequest.configuredServerId, true);
        const replacement = this.getActor(parsedRequest.configuredServerId);
        if (parsedRequest.action === 'disconnect') {
          return replacement.snapshot();
        }
        return await replacement.connect();
      }
      await this.applyConfig(currentConfig, parsedRequest.configuredServerId, true);
      return await this.getActor(parsedRequest.configuredServerId).connect();
    });
  }
  private enqueueSerialized<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingReplacements += 1;
    const work = this.replacementTail.then(operation);
    const settled = () => {
      this.pendingReplacements -= 1;
    };
    this.replacementTail = work.then(settled, settled);
    return work;
  }
  private enqueueReplacement(
    config: McpHostConfig,
    invalidatedReplacementTarget?: ConfiguredMcpServerId,
    forceReplacement = false
  ): Promise<McpHostSnapshot> {
    return this.enqueueSerialized(
      async () => await this.applyConfig(config, invalidatedReplacementTarget, forceReplacement)
    );
  }
  watch(filter: McpHostWatchFilter, listener: (event: McpHostWatchEvent) => void): () => void {
    this.assertOpen();
    return this.options.publisher.watch(filter, listener);
  }
  close(): Promise<McpHostCloseReport> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const deferred = Promise.withResolvers<McpHostCloseReport>();
    this.closePromise = deferred.promise;
    const subscriptionsClosed = this.options.publisher.close();
    const actors = [...this.ownedActors];
    const closes = actors.map((actor) => this.startClose(actor));
    void Promise.all(closes).then((reports) => {
      this.recordRetirements(actors, reports);
      deferred.resolve(
        freezeReport([this.retiredReport, closedSubscriptionsReport(subscriptionsClosed)])
      );
    });
    return this.closePromise;
  }
  private async applyConfig(
    config: McpHostConfig,
    invalidatedReplacementTarget?: ConfiguredMcpServerId,
    forceReplacement = false
  ): Promise<McpHostSnapshot> {
    this.assertOpen();
    if (this.replacementFailure) {
      throw new McpHostServiceError('mcp-host-replacement-cleanup-failed', this.replacementFailure);
    }
    const retained = new Map<ConfiguredMcpServerId, ActorEntry>();
    for (const server of config.servers) {
      const current = this.actors.get(server.configuredServerId);
      const replaceInvalidated =
        invalidatedReplacementTarget === undefined ||
        invalidatedReplacementTarget === server.configuredServerId;
      const replaceForced =
        forceReplacement && invalidatedReplacementTarget === server.configuredServerId;
      if (
        current &&
        !replaceForced &&
        !(replaceInvalidated && current.actor.invalidated()) &&
        isDeepStrictEqual(current.config, server)
      ) {
        retained.set(server.configuredServerId, current);
      }
    }
    this.snapshotActors(retained);
    const retiring = [...this.actors].filter(([id]) => !retained.has(id));
    this.actors = retained;
    const retiringActors = retiring.map(([, entry]) => entry.actor);
    const reports = await Promise.all(retiringActors.map((actor) => this.startClose(actor)));
    this.recordRetirements(retiringActors, reports);
    const retirementReport = freezeReport(reports);
    if (retirementReport.failures.length > 0) {
      this.assertOpen();
      this.replacementFailure = retirementReport;
      this.reconcileRetainedAuthority(retained, retirementReport);
      throw new McpHostServiceError('mcp-host-replacement-cleanup-failed', retirementReport);
    }
    this.assertOpen();
    const next = new Map(retained);
    const provisional: McpHostActor[] = [];
    const snapshots = this.snapshotRetainedAuthority(retained);
    for (const server of config.servers) {
      if (retained.has(server.configuredServerId)) {
        continue;
      }
      const generation = (this.generations.get(server.configuredServerId) ?? 0) + 1;
      this.generations.set(server.configuredServerId, generation);
      let actor: McpHostActor | undefined;
      try {
        actor = this.options.actorFactory({
          config: server,
          generation,
          onSnapshotChanged: (snapshot) => {
            if (this.closePromise) {
              return;
            }
            if (!actor || this.actors.get(server.configuredServerId)?.actor !== actor) {
              this.reportInternalError('mcp-host-unpublished-actor-transition', snapshot);
              return;
            }
            this.options.publisher.publishActorTransition(snapshot);
          },
        });
      } catch (cause) {
        return this.failProvisional('mcp-host-actor-create-failed', cause, provisional, retained);
      }
      this.ownedActors.add(actor);
      provisional.push(actor);
      next.set(server.configuredServerId, { actor, config: server });
      try {
        snapshots.push(actor.snapshot());
      } catch (cause) {
        return this.failProvisional('mcp-host-actor-snapshot-failed', cause, provisional, retained);
      }
    }
    this.assertOpen();
    let published: McpHostSnapshot;
    try {
      published = this.publishConfigSet(snapshots);
    } catch {
      return this.failPublication(provisional, retained);
    }
    this.actors = next;
    return published;
  }
  private currentConfig(): McpHostConfig {
    return { servers: [...this.actors.values()].map(({ config }) => config) };
  }
  private getActor(configuredServerId: ConfiguredMcpServerId): McpHostActor {
    const actor = this.actors.get(configuredServerId)?.actor;
    if (!actor) {
      throw new McpHostServiceError('mcp-host-server-unknown');
    }
    return actor;
  }
  private assertOpen(): void {
    if (this.closePromise) {
      throw new McpHostServiceError('mcp-host-closed');
    }
  }
  private startClose(actor: McpHostActor): Promise<McpHostCloseReport> {
    const existing = this.closeWork.get(actor);
    if (existing) {
      return existing;
    }
    let work: Promise<McpHostCloseReport>;
    try {
      work = Promise.resolve(actor.close()).catch((cause: unknown) => {
        this.reportInternalError('mcp-host-actor-close-failed', cause);
        return failedCloseReport();
      });
    } catch (cause) {
      this.reportInternalError('mcp-host-actor-close-failed', cause);
      work = Promise.resolve(failedCloseReport());
    }
    this.closeWork.set(actor, work);
    return work;
  }
  private async failProvisional(
    code: 'mcp-host-actor-create-failed' | 'mcp-host-actor-snapshot-failed',
    cause: unknown,
    actors: readonly McpHostActor[],
    retained: ReadonlyMap<ConfiguredMcpServerId, ActorEntry>
  ): Promise<never> {
    this.reportInternalError(code, cause);
    const reports = await Promise.all(actors.map((actor) => this.startClose(actor)));
    this.recordRetirements(actors, reports);
    const cleanup = freezeReport(reports);
    this.assertOpen();
    this.reconcileRetainedAuthority(retained, cleanup);
    if (cleanup.failures.length > 0) {
      throw new McpHostServiceError('mcp-host-replacement-cleanup-failed', cleanup);
    }
    throw new McpHostServiceError(code);
  }
  private async failPublication(
    actors: readonly McpHostActor[],
    retained: ReadonlyMap<ConfiguredMcpServerId, ActorEntry>
  ): Promise<never> {
    const reports = await Promise.all(actors.map((actor) => this.startClose(actor)));
    this.recordRetirements(actors, reports);
    const cleanup = freezeReport(reports);
    this.assertOpen();
    this.reconcileRetainedAuthority(retained, cleanup);
    if (cleanup.failures.length > 0) {
      throw new McpHostServiceError('mcp-host-replacement-cleanup-failed', cleanup);
    }
    throw new McpHostServiceError('mcp-host-publish-failed');
  }
  private reconcileRetainedAuthority(
    retained: ReadonlyMap<ConfiguredMcpServerId, ActorEntry>,
    cleanup: McpHostCloseReport
  ): void {
    if (cleanup.failures.length > 0) {
      this.replacementFailure = cleanup;
    }
    try {
      this.publishConfigSet(this.snapshotRetainedAuthority(retained));
    } catch (cause) {
      const code =
        cause instanceof McpHostServiceError && cause.code === 'mcp-host-actor-snapshot-failed'
          ? cause.code
          : 'mcp-host-publish-failed';
      this.replacementFailure ??= failedAuthorityReconciliationReport(code);
      throw cause;
    }
  }
  private snapshotActors(
    actors: ReadonlyMap<ConfiguredMcpServerId, ActorEntry>
  ): McpHostServerSnapshot[] {
    try {
      return [...actors.values()].map(({ actor }) => actor.snapshot());
    } catch (cause) {
      this.reportInternalError('mcp-host-actor-snapshot-failed', cause);
      throw new McpHostServiceError('mcp-host-actor-snapshot-failed');
    }
  }
  private snapshotRetainedAuthority(
    retained: ReadonlyMap<ConfiguredMcpServerId, ActorEntry>
  ): McpHostServerSnapshot[] {
    try {
      return this.snapshotActors(retained);
    } catch (cause) {
      this.replacementFailure ??= failedAuthorityReconciliationReport(
        'mcp-host-actor-snapshot-failed'
      );
      throw cause;
    }
  }
  private publishConfigSet(servers: readonly McpHostServerSnapshot[]): McpHostSnapshot {
    try {
      return this.options.publisher.publishConfigSet(servers);
    } catch (cause) {
      this.reportInternalError('mcp-host-publish-failed', cause);
      throw new McpHostServiceError('mcp-host-publish-failed');
    }
  }
  private recordRetirements(
    actors: readonly McpHostActor[],
    reports: readonly McpHostCloseReport[]
  ): void {
    actors.forEach((actor, index) => {
      if (this.recordedActors.has(actor)) {
        return;
      }
      const report = reports[index];
      if (!report) {
        throw new Error('MCP host close report alignment invariant failed');
      }
      this.recordedActors.add(actor);
      this.retiredReport = freezeReport([this.retiredReport, report]);
      this.ownedActors.delete(actor);
      this.closeWork.delete(actor);
    });
  }
  private reportInternalError(code: McpHostServiceInternalErrorCode, cause: unknown): void {
    try {
      const reporting = this.options.onInternalError(code, cause);
      void Promise.resolve(reporting).catch(() => {});
    } catch {}
  }
}
