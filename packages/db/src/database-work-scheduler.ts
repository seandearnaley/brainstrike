export type DatabaseWorkPriority = 'foreground' | 'normal' | 'background';

export interface DatabaseWorkOptions {
  readonly label?: string;
  readonly priority?: DatabaseWorkPriority;
}

export interface DatabaseWorkSchedulerSnapshot {
  readonly backgroundWaiting: boolean;
  readonly backgroundWaitingSince: number | null;
  readonly backgroundYieldCount: number;
  readonly currentBackgroundWaitMs: number;
  readonly foregroundQuietMs: number;
  readonly lastBackgroundYieldAt: number | null;
  readonly lastCompletedAt: number | null;
  readonly lastForegroundAt: number | null;
  readonly lastNormalAt: number | null;
  readonly lastStartedAt: number | null;
  readonly priorityStats: Record<DatabaseWorkPriority, DatabaseWorkPriorityStats>;
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningLabel: string | null;
  readonly runningPriority: DatabaseWorkPriority | null;
  readonly snapshotAt: number;
}

export interface DatabaseWorkPriorityStats {
  readonly completed: number;
  readonly lastCompletedLabel: string | null;
  readonly lastStartedLabel: string | null;
  readonly longestWaitMs: number;
  readonly queued: number;
  readonly serviceP50Ms: number;
  readonly serviceP95Ms: number;
  readonly started: number;
  readonly totalServiceMs: number;
  readonly totalWaitMs: number;
  readonly waitP50Ms: number;
  readonly waitP95Ms: number;
}

export interface DatabaseWorkSchedulerOptions {
  readonly foregroundQuietMs?: number;
  readonly now?: () => number;
}

export interface DatabaseWorkScheduler {
  readonly getSnapshot: () => DatabaseWorkSchedulerSnapshot;
  readonly run: <T>(work: () => Promise<T>, options?: DatabaseWorkOptions) => Promise<T>;
  readonly subscribe: (listener: (snapshot: DatabaseWorkSchedulerSnapshot) => void) => () => void;
}

export interface ScheduledDbHandle {
  readonly exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  readonly query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown
  ) => Promise<{ rows: T[] }>;
  readonly raw?: unknown;
  readonly transaction?: <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) => Promise<T>;
}

interface ScheduledTask<T> {
  readonly enqueuedAt: number;
  readonly label: string | null;
  readonly priority: DatabaseWorkPriority;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
  readonly work: () => Promise<T>;
}

type QueuedTask = ScheduledTask<unknown>;
type CallableUnknown = (...args: unknown[]) => unknown;

const PRIORITY_ORDER: readonly DatabaseWorkPriority[] = ['foreground', 'normal', 'background'];
const DEFAULT_FOREGROUND_QUIET_MS = 75;
const METRICS_WINDOW_SIZE = 64;
const SCHEDULER_SYMBOL = Symbol.for('brainstrike.databaseWorkScheduler');
const DEFAULT_PRIORITY_SYMBOL = Symbol.for('brainstrike.databaseWorkDefaultPriority');
// PGliteWorker listener methods use private fields, so they need the raw worker receiver.
// Keep this narrow: methods listed here bypass the scheduler proxy by design.
const RAW_RECEIVER_METHODS = new Set<PropertyKey>(['offLeaderChange', 'onLeaderChange']);
const rawReceiverMethodCache = new WeakMap<object, Map<PropertyKey, CallableUnknown>>();

interface MetricSamples {
  nextIndex: number;
  ordered: number[];
  sorted: number[];
}

function createEmptyQueues(): Record<DatabaseWorkPriority, QueuedTask[]> {
  return {
    foreground: [],
    normal: [],
    background: [],
  };
}

function createQueuedCounts(
  queues: Record<DatabaseWorkPriority, readonly QueuedTask[]>
): Record<DatabaseWorkPriority, number> {
  return {
    foreground: queues.foreground.length,
    normal: queues.normal.length,
    background: queues.background.length,
  };
}

function createEmptyPriorityStats(): Record<DatabaseWorkPriority, DatabaseWorkPriorityStats> {
  const emptyStats = (): DatabaseWorkPriorityStats => ({
    completed: 0,
    lastCompletedLabel: null,
    lastStartedLabel: null,
    longestWaitMs: 0,
    queued: 0,
    serviceP50Ms: 0,
    serviceP95Ms: 0,
    started: 0,
    totalServiceMs: 0,
    totalWaitMs: 0,
    waitP50Ms: 0,
    waitP95Ms: 0,
  });
  return {
    foreground: emptyStats(),
    normal: emptyStats(),
    background: emptyStats(),
  };
}

function clonePriorityStats(
  stats: Record<DatabaseWorkPriority, DatabaseWorkPriorityStats>
): Record<DatabaseWorkPriority, DatabaseWorkPriorityStats> {
  return {
    foreground: { ...stats.foreground },
    normal: { ...stats.normal },
    background: { ...stats.background },
  };
}

function createEmptyMetricWindow(): MetricSamples {
  return {
    nextIndex: 0,
    ordered: [],
    sorted: [],
  };
}

function createEmptyMetricSamples(): Record<DatabaseWorkPriority, MetricSamples> {
  return {
    foreground: createEmptyMetricWindow(),
    normal: createEmptyMetricWindow(),
    background: createEmptyMetricWindow(),
  };
}

function calculatePercentile(samples: MetricSamples, percentile: number): number {
  if (samples.sorted.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.ceil(percentile * samples.sorted.length) - 1);
  return samples.sorted[index] ?? 0;
}

function findMetricInsertIndex(samples: readonly number[], value: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((samples[mid] ?? 0) <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function removeMetricSample(samples: number[], value: number): void {
  const insertionPoint = findMetricInsertIndex(samples, value);
  const candidateIndex = insertionPoint - 1;
  if (candidateIndex >= 0 && samples[candidateIndex] === value) {
    samples.splice(candidateIndex, 1);
    return;
  }
  const fallbackIndex = samples.indexOf(value);
  if (fallbackIndex >= 0) {
    samples.splice(fallbackIndex, 1);
  }
}

function addMetricSample(samples: MetricSamples, value: number): void {
  if (samples.ordered.length < METRICS_WINDOW_SIZE) {
    samples.ordered.push(value);
  } else {
    const replaced = samples.ordered[samples.nextIndex] ?? 0;
    samples.ordered[samples.nextIndex] = value;
    samples.nextIndex = (samples.nextIndex + 1) % METRICS_WINDOW_SIZE;
    removeMetricSample(samples.sorted, replaced);
  }
  samples.sorted.splice(findMetricInsertIndex(samples.sorted, value), 0, value);
}

function getRawReceiverMethod(target: object, property: PropertyKey): CallableUnknown | null {
  if (!RAW_RECEIVER_METHODS.has(property)) {
    return null;
  }
  const method = Reflect.get(target, property, target);
  if (typeof method !== 'function') {
    return null;
  }
  let targetMethods = rawReceiverMethodCache.get(target);
  if (!targetMethods) {
    targetMethods = new Map<PropertyKey, CallableUnknown>();
    rawReceiverMethodCache.set(target, targetMethods);
  }
  const cached = targetMethods.get(property);
  if (cached) {
    return cached;
  }
  const wrapper = (...args: unknown[]) => {
    const currentMethod = Reflect.get(target, property, target);
    if (typeof currentMethod !== 'function') {
      throw new TypeError(`Raw receiver method ${String(property)} is no longer callable`);
    }
    return Reflect.apply(currentMethod, target, args) as unknown;
  };
  targetMethods.set(property, wrapper);
  return wrapper;
}

function patchPriorityStat(
  stats: Record<DatabaseWorkPriority, DatabaseWorkPriorityStats>,
  priority: DatabaseWorkPriority,
  patch: Partial<DatabaseWorkPriorityStats>
): void {
  stats[priority] = {
    ...stats[priority],
    ...patch,
  };
}

function normalizePriority(priority: DatabaseWorkPriority | undefined): DatabaseWorkPriority {
  return priority ?? 'foreground';
}

function hasQueuedWork(queues: Record<DatabaseWorkPriority, readonly QueuedTask[]>): boolean {
  return PRIORITY_ORDER.some((priority) => queues[priority].length > 0);
}

function hasForegroundOrNormalWork(
  queues: Record<DatabaseWorkPriority, readonly QueuedTask[]>
): boolean {
  return queues.foreground.length > 0 || queues.normal.length > 0;
}

class DefaultDatabaseWorkScheduler implements DatabaseWorkScheduler {
  readonly #foregroundQuietMs: number;
  readonly #listeners = new Set<(snapshot: DatabaseWorkSchedulerSnapshot) => void>();
  readonly #now: () => number;
  readonly #priorityStats = createEmptyPriorityStats();
  readonly #queues = createEmptyQueues();
  readonly #serviceSamples = createEmptyMetricSamples();
  readonly #waitSamples = createEmptyMetricSamples();
  #backgroundWaitingSince: number | null = null;
  #backgroundYieldCount = 0;
  #drainMicrotaskScheduled = false;
  #drainTimer: ReturnType<typeof setTimeout> | null = null;
  #lastBackgroundYieldAt: number | null = null;
  #lastCompletedAt: number | null = null;
  #lastForegroundAt: number | null = null;
  #lastNormalAt: number | null = null;
  #lastStartedAt: number | null = null;
  #running = false;
  #runningStartedAt: number | null = null;
  #runningLabel: string | null = null;
  #runningPriority: DatabaseWorkPriority | null = null;

  constructor(options: DatabaseWorkSchedulerOptions = {}) {
    this.#foregroundQuietMs = Math.max(0, options.foregroundQuietMs ?? DEFAULT_FOREGROUND_QUIET_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  getSnapshot(): DatabaseWorkSchedulerSnapshot {
    const now = this.#now();
    return {
      backgroundWaiting: this.#backgroundWaitingSince !== null,
      backgroundWaitingSince: this.#backgroundWaitingSince,
      backgroundYieldCount: this.#backgroundYieldCount,
      currentBackgroundWaitMs:
        this.#backgroundWaitingSince === null ? 0 : Math.max(0, now - this.#backgroundWaitingSince),
      foregroundQuietMs: this.#foregroundQuietMs,
      lastBackgroundYieldAt: this.#lastBackgroundYieldAt,
      lastCompletedAt: this.#lastCompletedAt,
      lastForegroundAt: this.#lastForegroundAt,
      lastNormalAt: this.#lastNormalAt,
      lastStartedAt: this.#lastStartedAt,
      priorityStats: clonePriorityStats(this.#priorityStats),
      queued: createQueuedCounts(this.#queues),
      runningLabel: this.#runningLabel,
      runningPriority: this.#runningPriority,
      snapshotAt: now,
    };
  }

  run<T>(work: () => Promise<T>, options: DatabaseWorkOptions = {}): Promise<T> {
    const priority = normalizePriority(options.priority);
    const enqueuedAt = this.#now();
    if (priority === 'foreground') {
      this.#lastForegroundAt = enqueuedAt;
    }
    if (priority === 'normal') {
      this.#lastNormalAt = enqueuedAt;
    }

    patchPriorityStat(this.#priorityStats, priority, {
      queued: this.#priorityStats[priority].queued + 1,
    });
    if (
      priority === 'background' &&
      (this.#runningPriority === 'foreground' || this.#runningPriority === 'normal')
    ) {
      this.#markBackgroundWaiting(enqueuedAt);
    }

    return new Promise<T>((resolve, reject) => {
      this.#queues[priority].push({
        enqueuedAt,
        label: options.label ?? null,
        priority,
        reject,
        resolve: resolve as (value: unknown) => void,
        work: work as () => Promise<unknown>,
      });
      if (priority !== 'background' && this.#queues.background.length > 0) {
        this.#markBackgroundWaiting(enqueuedAt);
      }
      this.#emit();
      this.#scheduleDrain(0);
    });
  }

  subscribe(listener: (snapshot: DatabaseWorkSchedulerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }

  #markBackgroundWaiting(now: number): void {
    if (this.#backgroundWaitingSince !== null) {
      return;
    }
    this.#backgroundWaitingSince = now;
    this.#lastBackgroundYieldAt = now;
    this.#backgroundYieldCount += 1;
  }

  #clearBackgroundWaiting(): void {
    this.#backgroundWaitingSince = null;
  }

  #nextDelayMs(): number {
    if (this.#running || !hasQueuedWork(this.#queues)) {
      return 0;
    }

    if (hasForegroundOrNormalWork(this.#queues) || this.#queues.background.length === 0) {
      return 0;
    }

    const now = this.#now();
    const lastForegroundAt = this.#lastForegroundAt;
    if (lastForegroundAt === null) {
      return 0;
    }
    return Math.max(0, this.#foregroundQuietMs - (now - lastForegroundAt));
  }

  #pickNextTask(): QueuedTask | null {
    if (this.#running) {
      return null;
    }

    for (const priority of PRIORITY_ORDER) {
      if (
        priority === 'foreground' &&
        this.#queues.background.length > 0 &&
        hasForegroundOrNormalWork(this.#queues)
      ) {
        this.#markBackgroundWaiting(this.#now());
      }

      if (priority === 'background') {
        const delayMs = this.#nextDelayMs();
        if (delayMs > 0) {
          this.#markBackgroundWaiting(this.#now());
          this.#emit();
          this.#scheduleDrain(delayMs);
          return null;
        }
      }

      const task = this.#queues[priority].shift();
      if (task) {
        const now = this.#now();
        this.#lastStartedAt = now;
        this.#runningStartedAt = now;
        this.#recordTaskStarted(task, now);
        if (priority === 'background') {
          this.#clearBackgroundWaiting();
        }
        return task;
      }
    }

    if (this.#backgroundWaitingSince !== null) {
      this.#clearBackgroundWaiting();
    }
    return null;
  }

  #scheduleDrain(delayMs: number): void {
    if (this.#drainTimer !== null) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }

    if (delayMs <= 0) {
      if (this.#drainMicrotaskScheduled) {
        return;
      }
      this.#drainMicrotaskScheduled = true;
      queueMicrotask(() => {
        this.#drainMicrotaskScheduled = false;
        void this.#drain();
      });
      return;
    }

    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = null;
      void this.#drain();
    }, delayMs);
  }

  async #drain(): Promise<void> {
    const task = this.#pickNextTask();
    if (!task) {
      this.#emit();
      return;
    }

    this.#running = true;
    this.#runningPriority = task.priority;
    this.#runningLabel = task.label;
    this.#emit();

    try {
      const result = await task.work();
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      const completedAt = this.#now();
      this.#lastCompletedAt = completedAt;
      this.#recordTaskCompleted(task, this.#runningStartedAt ?? completedAt, completedAt);
      this.#running = false;
      this.#runningStartedAt = null;
      this.#runningPriority = null;
      this.#runningLabel = null;
      this.#emit();
    }

    if (hasQueuedWork(this.#queues)) {
      this.#scheduleDrain(this.#nextDelayMs());
    }
  }

  #recordTaskStarted(task: QueuedTask, startedAt: number): void {
    const waitMs = Math.max(0, startedAt - task.enqueuedAt);
    const waitSamples = this.#waitSamples[task.priority];
    addMetricSample(waitSamples, waitMs);
    const current = this.#priorityStats[task.priority];
    patchPriorityStat(this.#priorityStats, task.priority, {
      lastStartedLabel: task.label,
      longestWaitMs: Math.max(current.longestWaitMs, waitMs),
      started: current.started + 1,
      totalWaitMs: current.totalWaitMs + waitMs,
      waitP50Ms: calculatePercentile(waitSamples, 0.5),
      waitP95Ms: calculatePercentile(waitSamples, 0.95),
    });
  }

  #recordTaskCompleted(task: QueuedTask, startedAt: number, completedAt: number): void {
    const serviceMs = Math.max(0, completedAt - startedAt);
    const serviceSamples = this.#serviceSamples[task.priority];
    addMetricSample(serviceSamples, serviceMs);
    const current = this.#priorityStats[task.priority];
    patchPriorityStat(this.#priorityStats, task.priority, {
      completed: current.completed + 1,
      lastCompletedLabel: task.label,
      serviceP50Ms: calculatePercentile(serviceSamples, 0.5),
      serviceP95Ms: calculatePercentile(serviceSamples, 0.95),
      totalServiceMs: current.totalServiceMs + serviceMs,
    });
  }
}

export function createDatabaseWorkScheduler(
  options?: DatabaseWorkSchedulerOptions
): DatabaseWorkScheduler {
  return new DefaultDatabaseWorkScheduler(options);
}

function getSchedulerFromHandle(handle: unknown): DatabaseWorkScheduler | null {
  if (!handle || typeof handle !== 'object') {
    return null;
  }
  const scheduler = (handle as { [SCHEDULER_SYMBOL]?: unknown })[SCHEDULER_SYMBOL];
  if (scheduler && typeof scheduler === 'object' && 'run' in scheduler) {
    return scheduler as DatabaseWorkScheduler;
  }
  const raw = (handle as { raw?: unknown }).raw;
  if (raw && raw !== handle) {
    return getSchedulerFromHandle(raw);
  }
  return null;
}

function getDefaultPriorityFromHandle(handle: unknown): DatabaseWorkPriority | null {
  if (!handle || typeof handle !== 'object') {
    return null;
  }
  const priority = (handle as { [DEFAULT_PRIORITY_SYMBOL]?: unknown })[DEFAULT_PRIORITY_SYMBOL];
  if (priority === 'foreground' || priority === 'normal' || priority === 'background') {
    return priority;
  }
  const raw = (handle as { raw?: unknown }).raw;
  if (raw && raw !== handle) {
    return getDefaultPriorityFromHandle(raw);
  }
  return null;
}

function mergeOptions(
  defaultPriority: DatabaseWorkPriority,
  options: DatabaseWorkOptions | undefined
): DatabaseWorkOptions {
  return {
    ...(options ?? {}),
    priority: options?.priority ?? defaultPriority,
  };
}

function isDatabaseWorkOptions(value: unknown): value is DatabaseWorkOptions {
  if (!isObjectRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'priority' && key !== 'label')) {
    return false;
  }
  if (
    value['priority'] !== 'foreground' &&
    value['priority'] !== 'normal' &&
    value['priority'] !== 'background'
  ) {
    return false;
  }
  return value['label'] === undefined || typeof value['label'] === 'string';
}

function splitDatabaseWorkOptions(args: readonly unknown[]): {
  readonly databaseWorkOptions: DatabaseWorkOptions | undefined;
  readonly forwardedArgs: unknown[];
} {
  // Only an explicit scheduler priority marks the final argument as work options. That keeps
  // label-only native query option objects flowing through to the wrapped DB unchanged.
  const lastArg = args.at(-1);
  if (!isDatabaseWorkOptions(lastArg)) {
    return { databaseWorkOptions: undefined, forwardedArgs: [...args] };
  }
  return {
    databaseWorkOptions: lastArg,
    forwardedArgs: args.slice(0, -1),
  };
}

function appendDatabaseWorkOptions(
  forwardedArgs: readonly unknown[],
  options: DatabaseWorkOptions,
  scheduler: DatabaseWorkScheduler | null
): unknown[] {
  if (scheduler) {
    return [...forwardedArgs, options];
  }
  if (forwardedArgs.length === 1) {
    return [forwardedArgs[0], undefined, options];
  }
  if (forwardedArgs.length === 2) {
    return [...forwardedArgs, options];
  }
  throw new Error(
    'Cannot apply database work options to an unscheduled DB handle when native query options are already provided.'
  );
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function createScheduledLiveQueryHandle<THandle extends object>(
  handle: THandle,
  scheduler: DatabaseWorkScheduler,
  priority: DatabaseWorkPriority
): THandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'refresh') {
        const refresh = Reflect.get(target, property, receiver);
        if (typeof refresh !== 'function') {
          return refresh;
        }
        return async (...args: unknown[]) =>
          await scheduler.run(
            async () => await Reflect.apply(refresh as CallableUnknown, target, args),
            { priority, label: 'live query refresh' }
          );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function createScheduledLiveNamespace<TLive extends object>(
  live: TLive,
  scheduler: DatabaseWorkScheduler,
  priority: DatabaseWorkPriority
): TLive {
  return new Proxy(live, {
    get(target, property, receiver) {
      if (property === 'query' || property === 'incrementalQuery') {
        const startLiveQuery = Reflect.get(target, property, receiver);
        if (typeof startLiveQuery !== 'function') {
          return startLiveQuery;
        }
        const label = property === 'query' ? 'live query' : 'live incremental query';
        return async (...args: unknown[]) =>
          await scheduler.run(
            async () => {
              const handle = await Reflect.apply(startLiveQuery as CallableUnknown, target, args);
              return isObjectRecord(handle)
                ? createScheduledLiveQueryHandle(handle, scheduler, priority)
                : handle;
            },
            { priority, label }
          );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function createPriorityOptionsDbHandle<TDatabase extends object & ScheduledDbHandle>(
  db: TDatabase,
  priority: DatabaseWorkPriority,
  scheduler: DatabaseWorkScheduler | null
): TDatabase {
  const prioritizedQuery = async <T = unknown>(...args: unknown[]) => {
    const { databaseWorkOptions, forwardedArgs } = splitDatabaseWorkOptions(args);
    return (await Reflect.apply(
      db.query,
      db,
      appendDatabaseWorkOptions(
        forwardedArgs,
        mergeOptions(priority, databaseWorkOptions),
        scheduler
      )
    )) as { rows: T[] };
  };

  const prioritizedExec = db.exec
    ? async (...args: unknown[]) => {
        const { databaseWorkOptions, forwardedArgs } = splitDatabaseWorkOptions(args);
        return await Reflect.apply(
          db.exec as CallableUnknown,
          db,
          appendDatabaseWorkOptions(
            forwardedArgs,
            mergeOptions(priority, databaseWorkOptions),
            scheduler
          )
        );
      }
    : undefined;

  const baseTransaction = db.transaction;
  const prioritizedTransaction: ScheduledDbHandle['transaction'] | undefined = baseTransaction
    ? async <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) =>
        (await Reflect.apply(baseTransaction as CallableUnknown, db, [
          async (tx: ScheduledDbHandle) => await fn(tx),
        ])) as T
    : undefined;

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'query') {
        return prioritizedQuery;
      }
      if (property === 'exec') {
        return prioritizedExec;
      }
      if (property === 'transaction') {
        return prioritizedTransaction;
      }
      if (property === 'live') {
        const live = Reflect.get(target, property, receiver);
        return scheduler && isObjectRecord(live)
          ? createScheduledLiveNamespace(live, scheduler, priority)
          : live;
      }
      if (property === SCHEDULER_SYMBOL) {
        return scheduler;
      }
      if (property === DEFAULT_PRIORITY_SYMBOL) {
        return priority;
      }
      const rawReceiverMethod = getRawReceiverMethod(target, property);
      if (rawReceiverMethod) {
        return rawReceiverMethod;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function getDatabaseWorkScheduler(handle: unknown): DatabaseWorkScheduler | null {
  return getSchedulerFromHandle(handle);
}

export function getDatabaseWorkDefaultPriority(handle: unknown): DatabaseWorkPriority | null {
  return getDefaultPriorityFromHandle(handle);
}

export function createScheduledDbHandle<TDatabase extends object & ScheduledDbHandle>(
  db: TDatabase,
  scheduler: DatabaseWorkScheduler,
  defaultPriority: DatabaseWorkPriority
): TDatabase {
  const scheduledQuery = async <T = unknown>(...args: unknown[]) => {
    const { databaseWorkOptions, forwardedArgs } = splitDatabaseWorkOptions(args);
    return (await scheduler.run(
      async () => await Reflect.apply(db.query, db, forwardedArgs),
      mergeOptions(defaultPriority, databaseWorkOptions)
    )) as { rows: T[] };
  };

  const scheduledExec = db.exec
    ? async (...args: unknown[]) => {
        const { databaseWorkOptions, forwardedArgs } = splitDatabaseWorkOptions(args);
        return await scheduler.run(
          async () => await Reflect.apply(db.exec as CallableUnknown, db, forwardedArgs),
          mergeOptions(defaultPriority, databaseWorkOptions)
        );
      }
    : undefined;

  const baseTransaction = db.transaction;
  const scheduledTransaction: ScheduledDbHandle['transaction'] | undefined = baseTransaction
    ? async <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) =>
        (await scheduler.run(
          async () =>
            await Reflect.apply(baseTransaction as CallableUnknown, db, [
              async (tx: ScheduledDbHandle) => await fn(tx),
            ]),
          { priority: defaultPriority, label: 'transaction' }
        )) as T
    : undefined;

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'query') {
        return scheduledQuery;
      }
      if (property === 'exec') {
        return scheduledExec;
      }
      if (property === 'transaction') {
        return scheduledTransaction;
      }
      if (property === 'live') {
        const live = Reflect.get(target, property, receiver);
        return isObjectRecord(live)
          ? createScheduledLiveNamespace(live, scheduler, defaultPriority)
          : live;
      }
      if (property === SCHEDULER_SYMBOL) {
        return scheduler;
      }
      if (property === DEFAULT_PRIORITY_SYMBOL) {
        return defaultPriority;
      }
      const rawReceiverMethod = getRawReceiverMethod(target, property);
      if (rawReceiverMethod) {
        return rawReceiverMethod;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function createPriorityDbHandle<TDatabase extends object & ScheduledDbHandle>(
  db: TDatabase,
  priority: DatabaseWorkPriority
): TDatabase {
  const scheduler = getSchedulerFromHandle(db);
  if (!scheduler) {
    return createPriorityOptionsDbHandle(db, priority, null);
  }
  return createPriorityOptionsDbHandle(db, priority, scheduler);
}
