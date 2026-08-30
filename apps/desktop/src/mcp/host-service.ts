import { isDeepStrictEqual } from 'node:util';
import {
  type ConfiguredMcpServerId,
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostError,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  type McpHostWatchEvent,
  type McpHostWatchFilter,
  parseMcpHostConfig,
} from '@brainstrike/assistant-contract';
import {
  type McpHostRevisionPublisher,
  McpHostRevisionPublisherClosedError,
} from './host-revision-publisher';

type ConfiguredServer = McpHostConfig['servers'][number];
type Counter = Exclude<keyof McpHostCloseReport, 'failures'>;
const COUNTERS: readonly Counter[] = [
  'callbacksClosed',
  'childProcessesClosed',
  'clientsClosed',
  'loopbackPortsClosed',
  'probesClosed',
  'requestsSettled',
  'subscriptionsClosed',
];
export interface McpHostActor extends Pick<McpHostPort, 'close' | 'invoke'> {
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
  publisher: McpHostRevisionPublisher;
}
export class McpHostServiceError extends Error {
  readonly category: 'configuration' | 'transport';
  constructor(
    readonly code: 'mcp-host-replacement-cleanup-failed' | 'mcp-host-server-unknown',
    readonly report?: McpHostCloseReport
  ) {
    super('MCP host operation failed');
    this.name = 'McpHostServiceError';
    this.category = code === 'mcp-host-server-unknown' ? 'configuration' : 'transport';
  }
}
function freezeReport(reports: readonly McpHostCloseReport[]): McpHostCloseReport {
  const aggregate = Object.fromEntries(COUNTERS.map((counter) => [counter, 0])) as Record<
    Counter,
    number
  >;
  const failures: McpHostError[] = [];
  for (const report of reports) {
    for (const counter of COUNTERS) {
      aggregate[counter] += report[counter];
    }
    failures.push(...report.failures);
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
const failedCloseReport = (): McpHostCloseReport =>
  freezeReport([{ ...EMPTY_COUNTERS, failures: [ACTOR_CLOSE_FAILURE] }]);
export class McpHostService implements McpHostPort {
  private actors = new Map<ConfiguredMcpServerId, ActorEntry>();
  private readonly blocked = new Map<ConfiguredMcpServerId, McpHostCloseReport>();
  private readonly closeWork = new Map<McpHostActor, Promise<McpHostCloseReport>>();
  private closePromise: Promise<McpHostCloseReport> | undefined;
  private readonly generations = new Map<ConfiguredMcpServerId, number>();
  private readonly ownedActors = new Set<McpHostActor>();
  private pendingReplacements = 0;
  private replacementTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: McpHostServiceOptions) {}
  snapshot(): McpHostSnapshot {
    return this.options.publisher.snapshot();
  }
  invoke(operation: McpHostOperation): Promise<McpHostOperationResult> {
    if (this.closePromise) {
      return Promise.reject(new McpHostRevisionPublisherClosedError());
    }
    const invoke = () => {
      this.assertOpen();
      const entry = this.actors.get(operation.configuredServerId);
      if (!entry) {
        throw new McpHostServiceError('mcp-host-server-unknown');
      }
      return entry.actor.invoke(operation);
    };
    return this.pendingReplacements === 0 ? invoke() : this.replacementTail.then(invoke);
  }
  replaceConfig(config: McpHostConfig): Promise<McpHostSnapshot> {
    const parsed = parseMcpHostConfig(config);
    if (this.closePromise) {
      return Promise.reject(new McpHostRevisionPublisherClosedError());
    }
    this.pendingReplacements += 1;
    const replacement = this.replacementTail.then(() => this.applyConfig(parsed));
    this.replacementTail = replacement.then(
      () => {
        this.pendingReplacements -= 1;
      },
      () => {
        this.pendingReplacements -= 1;
      }
    );
    return replacement;
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
    this.options.publisher.close();
    const closes = [...this.ownedActors].map((actor) => this.startClose(actor));
    void Promise.all(closes).then((reports) => deferred.resolve(freezeReport(reports)));
    return this.closePromise;
  }
  private async applyConfig(config: McpHostConfig): Promise<McpHostSnapshot> {
    this.assertOpen();
    for (const server of config.servers) {
      const blocked = this.blocked.get(server.configuredServerId);
      if (blocked) {
        throw new McpHostServiceError('mcp-host-replacement-cleanup-failed', blocked);
      }
    }
    const retained = new Map<ConfiguredMcpServerId, ActorEntry>();
    for (const server of config.servers) {
      const current = this.actors.get(server.configuredServerId);
      if (current && isDeepStrictEqual(current.config, server)) {
        retained.set(server.configuredServerId, current);
      }
    }
    const retiring = [...this.actors].filter(([id]) => !retained.has(id));
    this.actors = retained;
    const reports = await Promise.all(retiring.map(([, entry]) => this.startClose(entry.actor)));
    if (reports.some(({ failures }) => failures.length > 0)) {
      retiring.forEach(([id], index) => {
        const report = reports[index];
        if (report?.failures.length) {
          this.blocked.set(id, freezeReport([report]));
        }
      });
      throw new McpHostServiceError('mcp-host-replacement-cleanup-failed', freezeReport(reports));
    }
    this.assertOpen();
    for (const server of config.servers) {
      if (retained.has(server.configuredServerId)) {
        continue;
      }
      const generation = (this.generations.get(server.configuredServerId) ?? 0) + 1;
      const actor = this.options.actorFactory({
        config: server,
        generation,
        onSnapshotChanged: (snapshot) => this.options.publisher.publishActorTransition(snapshot),
      });
      this.generations.set(server.configuredServerId, generation);
      this.ownedActors.add(actor);
      retained.set(server.configuredServerId, { actor, config: server });
    }
    this.actors = retained;
    return this.options.publisher.publishConfigSet(
      [...retained.values()].map(({ actor }) => actor.snapshot())
    );
  }
  private assertOpen(): void {
    if (this.closePromise) {
      throw new McpHostRevisionPublisherClosedError();
    }
  }
  private startClose(actor: McpHostActor): Promise<McpHostCloseReport> {
    const existing = this.closeWork.get(actor);
    if (existing) {
      return existing;
    }
    let work: Promise<McpHostCloseReport>;
    try {
      work = Promise.resolve(actor.close()).catch(() => failedCloseReport());
    } catch {
      work = Promise.resolve(failedCloseReport());
    }
    this.closeWork.set(actor, work);
    return work;
  }
}
