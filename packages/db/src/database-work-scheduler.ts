import {
  measureDatabaseQuery,
  recordDatabaseLiveSubscriptionEnded,
  recordDatabaseLiveSubscriptionStarted,
  recordDatabaseLiveUpdate,
} from './database-query-telemetry.js';

export type DatabaseWorkPriority = 'foreground' | 'normal' | 'background';

export interface DatabaseWorkOptions {
  readonly label?: string;
  readonly priority?: DatabaseWorkPriority;
}

/**
 * Options for direct scheduler.run calls. Unlike handle-level DatabaseWorkOptions
 * (where a deliberate default priority comes from the handle), direct scheduler
 * work must declare its priority explicitly — there is no safe default.
 */
export interface DatabaseWorkRunOptions {
  readonly label?: string;
  readonly priority: DatabaseWorkPriority;
}

export interface DatabaseWorkSchedulerSnapshot {
  readonly backgroundWaiting: boolean;
  readonly backgroundWaitingSince: number | null;
  readonly backgroundYieldCount: number;
  readonly currentBackgroundWaitMs: number;
  readonly elapsedSnapshotAt: number;
  readonly forcedBackgroundAdmissionCount: number;
  readonly foregroundQuietMs: number;
  readonly lastBackgroundYieldAt: number | null;
  readonly lastCompletedAt: number | null;
  readonly lastForegroundAt: number | null;
  readonly lastForegroundElapsedAt: number | null;
  readonly lastNormalAt: number | null;
  readonly lastNormalElapsedAt: number | null;
  readonly lastStartedAt: number | null;
  readonly priorityStats: Record<DatabaseWorkPriority, DatabaseWorkPriorityStats>;
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly queuedLabels: Record<DatabaseWorkPriority, readonly (string | null)[]>;
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
  /**
   * Maximum continuous wait before one queued background task receives a turn.
   * The wait clock restarts after that task, preserving foreground preference
   * while guaranteeing bounded progress under sustained foreground arrivals.
   */
  readonly backgroundStarvationMs?: number;
  /** Monotonic elapsed-time source. Defaults to performance.now(). Inject explicitly in tests. */
  readonly elapsedNow?: () => number;
  readonly foregroundQuietMs?: number;
  /** Wall-clock source for diagnostics only; it never controls fairness admission. */
  readonly now?: () => number;
}

export interface DatabaseWorkScheduler {
  readonly getSnapshot: () => DatabaseWorkSchedulerSnapshot;
  readonly run: <T>(work: () => Promise<T>, options: DatabaseWorkRunOptions) => Promise<T>;
  readonly subscribe: (listener: (snapshot: DatabaseWorkSchedulerSnapshot) => void) => () => void;
}

export interface ScheduledDbHandle {
  // `params` stays MUTABLE here: existing callers (db-provider's QueryExecutor)
  // declare `unknown[]`, and widening to `readonly` makes them structurally
  // incompatible under contravariance.
  readonly exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  readonly insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly never[],
    fileRecordId: string,
    options: never,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  readonly query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown
  ) => Promise<{ rows: T[] }>;
  readonly raw?: unknown;
  readonly syncToFs?: () => Promise<void>;
  readonly transaction?: <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) => Promise<T>;
}

interface ScheduledTask<T> {
  readonly elapsedEnqueuedAt: number;
  readonly label: string | null;
  readonly priority: DatabaseWorkPriority;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
  readonly work: () => Promise<T>;
}

type QueuedTask = ScheduledTask<unknown>;
type CallableUnknown = (...args: unknown[]) => unknown;

const PRIORITY_ORDER: readonly DatabaseWorkPriority[] = ['foreground', 'normal', 'background'];
const DEFAULT_BACKGROUND_STARVATION_MS = 250;
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

interface SchedulerClockSample {
  readonly elapsedAt: number;
  readonly wallAt: number;
}

function createEmptyQueues(): Record<DatabaseWorkPriority, QueuedTask[]> {
  return {
    background: [],
    foreground: [],
    normal: [],
  };
}

function createQueuedCounts(
  queues: Record<DatabaseWorkPriority, readonly QueuedTask[]>
): Record<DatabaseWorkPriority, number> {
  return {
    background: queues.background.length,
    foreground: queues.foreground.length,
    normal: queues.normal.length,
  };
}

function createQueuedLabels(
  queues: Record<DatabaseWorkPriority, readonly QueuedTask[]>
): Record<DatabaseWorkPriority, readonly (string | null)[]> {
  return {
    background: queues.background.map((task) => task.label),
    foreground: queues.foreground.map((task) => task.label),
    normal: queues.normal.map((task) => task.label),
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
    background: emptyStats(),
    foreground: emptyStats(),
    normal: emptyStats(),
  };
}

function clonePriorityStats(
  stats: Record<DatabaseWorkPriority, DatabaseWorkPriorityStats>
): Record<DatabaseWorkPriority, DatabaseWorkPriorityStats> {
  return {
    background: { ...stats.background },
    foreground: { ...stats.foreground },
    normal: { ...stats.normal },
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
    background: createEmptyMetricWindow(),
    foreground: createEmptyMetricWindow(),
    normal: createEmptyMetricWindow(),
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

function requireExplicitPriority(priority: DatabaseWorkPriority | undefined): DatabaseWorkPriority {
  if (priority === 'foreground' || priority === 'normal' || priority === 'background') {
    return priority;
  }
  // No silent default: an unprioritized caller jumping the foreground queue is
  // exactly the bug this guard exists to surface.
  throw new Error(
    "DatabaseWorkScheduler.run requires an explicit priority ('foreground' | 'normal' | 'background')."
  );
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
  readonly #backgroundStarvationMs: number;
  readonly #elapsedNow: () => number;
  readonly #foregroundQuietMs: number;
  readonly #listeners = new Set<(snapshot: DatabaseWorkSchedulerSnapshot) => void>();
  readonly #now: () => number;
  readonly #priorityStats = createEmptyPriorityStats();
  readonly #queues = createEmptyQueues();
  readonly #serviceSamples = createEmptyMetricSamples();
  readonly #waitSamples = createEmptyMetricSamples();
  #backgroundYieldRequiresForegroundTurn = false;
  #backgroundWaiting: SchedulerClockSample | null = null;
  #backgroundYieldCount = 0;
  #drainMicrotaskScheduled = false;
  #drainTimer: ReturnType<typeof setTimeout> | null = null;
  #lastBackgroundYieldAt: number | null = null;
  #lastCompletedAt: number | null = null;
  #lastForeground: SchedulerClockSample | null = null;
  #lastNormal: SchedulerClockSample | null = null;
  #lastStartedAt: number | null = null;
  #forcedBackgroundAdmissionCount = 0;
  #running = false;
  #runningElapsedStartedAt: number | null = null;
  #runningLabel: string | null = null;
  #runningPriority: DatabaseWorkPriority | null = null;

  constructor(options: DatabaseWorkSchedulerOptions = {}) {
    const backgroundStarvationMs =
      options.backgroundStarvationMs ?? DEFAULT_BACKGROUND_STARVATION_MS;
    if (!Number.isFinite(backgroundStarvationMs) || backgroundStarvationMs <= 0) {
      throw new Error(
        'DatabaseWorkScheduler backgroundStarvationMs must be a positive finite number.'
      );
    }
    this.#backgroundStarvationMs = backgroundStarvationMs;
    const foregroundQuietMs = options.foregroundQuietMs ?? DEFAULT_FOREGROUND_QUIET_MS;
    if (!Number.isFinite(foregroundQuietMs) || foregroundQuietMs < 0) {
      throw new Error(
        'DatabaseWorkScheduler foregroundQuietMs must be a non-negative finite number.'
      );
    }
    this.#foregroundQuietMs = foregroundQuietMs;
    this.#now = options.now ?? (() => Date.now());
    this.#elapsedNow = options.elapsedNow ?? (() => globalThis.performance.now());
  }

  getSnapshot(): DatabaseWorkSchedulerSnapshot {
    const elapsedNow = this.#elapsedNow();
    const now = this.#now();
    return {
      backgroundWaiting: this.#backgroundWaiting !== null,
      backgroundWaitingSince: this.#backgroundWaiting?.wallAt ?? null,
      backgroundYieldCount: this.#backgroundYieldCount,
      currentBackgroundWaitMs:
        this.#backgroundWaiting === null
          ? 0
          : Math.max(0, elapsedNow - this.#backgroundWaiting.elapsedAt),
      elapsedSnapshotAt: elapsedNow,
      forcedBackgroundAdmissionCount: this.#forcedBackgroundAdmissionCount,
      foregroundQuietMs: this.#foregroundQuietMs,
      lastBackgroundYieldAt: this.#lastBackgroundYieldAt,
      lastCompletedAt: this.#lastCompletedAt,
      lastForegroundAt: this.#lastForeground?.wallAt ?? null,
      lastForegroundElapsedAt: this.#lastForeground?.elapsedAt ?? null,
      lastNormalAt: this.#lastNormal?.wallAt ?? null,
      lastNormalElapsedAt: this.#lastNormal?.elapsedAt ?? null,
      lastStartedAt: this.#lastStartedAt,
      priorityStats: clonePriorityStats(this.#priorityStats),
      queued: createQueuedCounts(this.#queues),
      queuedLabels: createQueuedLabels(this.#queues),
      runningLabel: this.#runningLabel,
      runningPriority: this.#runningPriority,
      snapshotAt: now,
    };
  }

  run<T>(work: () => Promise<T>, options: DatabaseWorkRunOptions): Promise<T> {
    // options?. because untyped JS callers can still omit the argument entirely;
    // requireExplicitPriority turns that into a loud failure instead of a default.
    const priority = requireExplicitPriority(options?.priority);
    const elapsedEnqueuedAt = this.#elapsedNow();
    const enqueuedAt = this.#now();
    if (priority === 'foreground') {
      this.#lastForeground = { elapsedAt: elapsedEnqueuedAt, wallAt: enqueuedAt };
    }
    if (priority === 'normal') {
      this.#lastNormal = { elapsedAt: elapsedEnqueuedAt, wallAt: enqueuedAt };
    }

    patchPriorityStat(this.#priorityStats, priority, {
      queued: this.#priorityStats[priority].queued + 1,
    });
    if (
      priority === 'background' &&
      (this.#runningPriority === 'foreground' ||
        this.#runningPriority === 'normal' ||
        hasForegroundOrNormalWork(this.#queues))
    ) {
      this.#markBackgroundWaiting(enqueuedAt, elapsedEnqueuedAt);
    }

    return new Promise<T>((resolve, reject) => {
      this.#queues[priority].push({
        elapsedEnqueuedAt,
        label: options?.label ?? null,
        priority,
        reject,
        resolve: resolve as (value: unknown) => void,
        work: work as () => Promise<unknown>,
      });
      if (priority !== 'background' && this.#queues.background.length > 0) {
        this.#markBackgroundWaiting(enqueuedAt, elapsedEnqueuedAt);
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

  #markBackgroundWaiting(now: number, elapsedNow: number): void {
    if (this.#backgroundWaiting !== null) {
      return;
    }
    this.#backgroundWaiting = { elapsedAt: elapsedNow, wallAt: now };
    this.#lastBackgroundYieldAt = now;
    this.#backgroundYieldCount += 1;
  }

  #clearBackgroundWaiting(): void {
    this.#backgroundWaiting = null;
  }

  #isBackgroundStarved(elapsedNow: number): boolean {
    return (
      !this.#backgroundYieldRequiresForegroundTurn &&
      this.#queues.background.length > 0 &&
      this.#backgroundWaiting !== null &&
      elapsedNow - this.#backgroundWaiting.elapsedAt >= this.#backgroundStarvationMs
    );
  }

  #nextDelayMs(elapsedNow = this.#elapsedNow()): number {
    if (this.#running || !hasQueuedWork(this.#queues)) {
      return 0;
    }

    if (hasForegroundOrNormalWork(this.#queues) || this.#queues.background.length === 0) {
      return 0;
    }

    if (this.#isBackgroundStarved(elapsedNow)) {
      return 0;
    }
    const lastForegroundElapsedAt = this.#lastForeground?.elapsedAt ?? null;
    if (lastForegroundElapsedAt === null) {
      return 0;
    }
    const quietWindowRemainingMs = Math.max(
      0,
      this.#foregroundQuietMs - (elapsedNow - lastForegroundElapsedAt)
    );
    const starvationRemainingMs =
      this.#backgroundWaiting === null
        ? this.#backgroundStarvationMs
        : Math.max(
            0,
            this.#backgroundStarvationMs - (elapsedNow - this.#backgroundWaiting.elapsedAt)
          );
    return Math.min(quietWindowRemainingMs, starvationRemainingMs);
  }

  #pickNextTask(): QueuedTask | null {
    if (this.#running) {
      return null;
    }

    const elapsedNow = this.#elapsedNow();
    const now = this.#now();
    if (this.#isBackgroundStarved(elapsedNow)) {
      const starvedTask = this.#queues.background.shift();
      if (starvedTask) {
        return this.#startTask(starvedTask, now, elapsedNow, true);
      }
    }

    for (const priority of PRIORITY_ORDER) {
      if (
        priority === 'foreground' &&
        this.#queues.background.length > 0 &&
        hasForegroundOrNormalWork(this.#queues)
      ) {
        this.#markBackgroundWaiting(now, elapsedNow);
      }

      if (priority === 'background') {
        const delayMs = this.#nextDelayMs(elapsedNow);
        if (delayMs > 0) {
          this.#markBackgroundWaiting(now, elapsedNow);
          this.#emit();
          this.#scheduleDrain(delayMs);
          return null;
        }
      }

      const task = this.#queues[priority].shift();
      if (task) {
        return this.#startTask(task, now, elapsedNow);
      }
    }

    this.#backgroundYieldRequiresForegroundTurn = false;
    return null;
  }

  #startTask(
    task: QueuedTask,
    startedAt: number,
    elapsedStartedAt: number,
    forcedBackground = false
  ): QueuedTask {
    this.#lastStartedAt = startedAt;
    this.#runningElapsedStartedAt = elapsedStartedAt;
    this.#recordTaskStarted(task, elapsedStartedAt);
    if (task.priority === 'background') {
      this.#clearBackgroundWaiting();
      if (forcedBackground) {
        this.#forcedBackgroundAdmissionCount += 1;
        this.#backgroundYieldRequiresForegroundTurn = true;
      }
      if (this.#queues.background.length > 0 && hasForegroundOrNormalWork(this.#queues)) {
        this.#markBackgroundWaiting(startedAt, elapsedStartedAt);
      }
    } else {
      this.#backgroundYieldRequiresForegroundTurn = false;
    }
    return task;
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
      const elapsedCompletedAt = this.#elapsedNow();
      const completedAt = this.#now();
      this.#lastCompletedAt = completedAt;
      this.#recordTaskCompleted(
        task,
        this.#runningElapsedStartedAt ?? elapsedCompletedAt,
        elapsedCompletedAt
      );
      this.#running = false;
      this.#runningElapsedStartedAt = null;
      this.#runningPriority = null;
      this.#runningLabel = null;
      this.#emit();
    }

    if (!hasQueuedWork(this.#queues)) {
      this.#backgroundYieldRequiresForegroundTurn = false;
      return;
    }
    this.#scheduleDrain(this.#nextDelayMs());
  }

  #recordTaskStarted(task: QueuedTask, elapsedStartedAt: number): void {
    const waitMs = Math.max(0, elapsedStartedAt - task.elapsedEnqueuedAt);
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

  #recordTaskCompleted(
    task: QueuedTask,
    elapsedStartedAt: number,
    elapsedCompletedAt: number
  ): void {
    const serviceMs = Math.max(0, elapsedCompletedAt - elapsedStartedAt);
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
): DatabaseWorkRunOptions {
  return {
    ...(options ?? {}),
    priority: options?.priority ?? defaultPriority,
  };
}

function describeSqlWork(kind: 'exec' | 'query', args: readonly unknown[]): string {
  const sql = typeof args[0] === 'string' ? args[0] : null;
  if (!sql) {
    return kind;
  }
  const normalizedSql = sql.replace(/\s+/g, ' ').trim();
  if (!normalizedSql) {
    return kind;
  }
  return `${kind}: ${normalizedSql.slice(0, 120)}`;
}

function mergeSqlWorkOptions(
  defaultPriority: DatabaseWorkPriority,
  options: DatabaseWorkOptions | undefined,
  kind: 'exec' | 'query',
  args: readonly unknown[]
): DatabaseWorkRunOptions {
  const merged = mergeOptions(defaultPriority, options);
  return {
    ...merged,
    label: merged.label ?? describeSqlWork(kind, args),
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
  refreshPriority: DatabaseWorkPriority
): THandle {
  let active = true;
  let subscribedListener: {
    counted: boolean;
    readonly listener: CallableUnknown;
    readonly wrappedListener: CallableUnknown;
  } | null = null;
  const assertActive = (): void => {
    if (!active) {
      throw new Error(
        'Scheduled PGlite live-query handle is no longer active; create a fresh handle'
      );
    }
  };
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'refresh') {
        const refresh = Reflect.get(target, property, receiver);
        if (typeof refresh !== 'function') {
          return refresh;
        }
        return async (...args: unknown[]) => {
          assertActive();
          return await measureDatabaseQuery(
            'live-query',
            async () =>
              await scheduler.run(
                async () => await Reflect.apply(refresh as CallableUnknown, target, args),
                { label: 'live query refresh', priority: refreshPriority }
              )
          );
        };
      }
      if (property === 'subscribe') {
        const subscribe = Reflect.get(target, property, receiver);
        if (typeof subscribe !== 'function') {
          return subscribe;
        }
        return (listener: CallableUnknown) => {
          assertActive();
          if (subscribedListener !== null) {
            throw new Error('Scheduled PGlite live-query handles support exactly one listener');
          }
          const wrappedListener = function (this: unknown, ...args: unknown[]) {
            if (entry.counted) {
              recordDatabaseLiveUpdate();
            }
            return Reflect.apply(listener, this, args) as unknown;
          };
          const entry = {
            counted: true,
            listener,
            wrappedListener,
          };
          let result: unknown;
          try {
            result = Reflect.apply(subscribe as CallableUnknown, target, [entry.wrappedListener]);
          } catch (error) {
            entry.counted = false;
            throw error;
          }
          subscribedListener = entry;
          recordDatabaseLiveSubscriptionStarted();
          return result;
        };
      }
      if (property === 'unsubscribe') {
        const unsubscribe = Reflect.get(target, property, receiver);
        if (typeof unsubscribe !== 'function') {
          return unsubscribe;
        }
        return async (listener: CallableUnknown) => {
          if (!active) {
            return;
          }
          if (subscribedListener !== null && subscribedListener.listener !== listener) {
            throw new Error(
              'Scheduled PGlite live-query unsubscribe listener does not match the active listener'
            );
          }
          // This wrapper OWNS its terminal state; it does not read the raw
          // handle's. Releasing before the await is deliberate and mirrors
          // PGlite, which removes the callback and latches `dead = true`
          // SYNCHRONOUSLY before awaiting its teardown transaction — so a
          // rejected unsubscribe leaves the raw handle permanently dead
          // upstream too, and no retry is available there either. Verified
          // unchanged in 0.5.5 (BST-1283).
          active = false;
          const entry = subscribedListener;
          try {
            return await Reflect.apply(unsubscribe as CallableUnknown, target, [
              entry?.wrappedListener ?? listener,
            ]);
          } finally {
            // PGlite detaches the callback before it can reject, so the
            // listener is genuinely gone on both the success and failure
            // paths. Release the one supported local owner to match.
            if (entry?.counted) {
              entry.counted = false;
              recordDatabaseLiveSubscriptionEnded();
            }
            subscribedListener = null;
          }
        };
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
  const liveQueryPriority = priority === 'foreground' ? 'normal' : priority;
  // PGlite live-query refreshes can fire from broad invalidations. Keep the
  // initial subscription responsive, but route repaint refreshes through the
  // idle lane so reactive churn cannot starve background indexing indefinitely.
  const liveRefreshPriority = priority === 'foreground' ? 'background' : priority;
  return new Proxy(live, {
    get(target, property, receiver) {
      if (property === 'query' || property === 'incrementalQuery') {
        const startLiveQuery = Reflect.get(target, property, receiver);
        if (typeof startLiveQuery !== 'function') {
          return startLiveQuery;
        }
        const label = property === 'query' ? 'live query' : 'live incremental query';
        return async (...args: unknown[]) =>
          await measureDatabaseQuery(
            'live-query',
            async () =>
              await scheduler.run(
                async () => {
                  const handle = await Reflect.apply(
                    startLiveQuery as CallableUnknown,
                    target,
                    args
                  );
                  return isObjectRecord(handle)
                    ? createScheduledLiveQueryHandle(handle, scheduler, liveRefreshPriority)
                    : handle;
                },
                { label, priority: liveQueryPriority }
              )
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
        mergeSqlWorkOptions(priority, databaseWorkOptions, 'query', forwardedArgs),
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
            mergeSqlWorkOptions(priority, databaseWorkOptions, 'exec', forwardedArgs),
            scheduler
          )
        );
      }
    : undefined;

  const baseInsertChunksAndEnqueueEmbeddingJobs = db.insertChunksAndEnqueueEmbeddingJobs;
  const prioritizedInsertChunksAndEnqueueEmbeddingJobs = baseInsertChunksAndEnqueueEmbeddingJobs
    ? async (...args: unknown[]) => {
        const { databaseWorkOptions, forwardedArgs } = splitDatabaseWorkOptions(args);
        return await Reflect.apply(baseInsertChunksAndEnqueueEmbeddingJobs, db, [
          ...forwardedArgs,
          mergeOptions(priority, databaseWorkOptions),
        ]);
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
      if (property === 'insertChunksAndEnqueueEmbeddingJobs') {
        return prioritizedInsertChunksAndEnqueueEmbeddingJobs;
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
      mergeSqlWorkOptions(defaultPriority, databaseWorkOptions, 'query', forwardedArgs)
    )) as { rows: T[] };
  };

  const scheduledExec = db.exec
    ? async (...args: unknown[]) => {
        const { databaseWorkOptions, forwardedArgs } = splitDatabaseWorkOptions(args);
        return await scheduler.run(
          async () => await Reflect.apply(db.exec as CallableUnknown, db, forwardedArgs),
          mergeSqlWorkOptions(defaultPriority, databaseWorkOptions, 'exec', forwardedArgs)
        );
      }
    : undefined;

  const baseSyncToFs = db.syncToFs;
  const scheduledSyncToFs = baseSyncToFs
    ? async () => {
        await scheduler.run(
          async () => {
            await Reflect.apply(baseSyncToFs as CallableUnknown, db, []);
          },
          { label: 'syncToFs', priority: defaultPriority }
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
          { label: 'transaction', priority: defaultPriority }
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
      if (property === 'syncToFs') {
        return scheduledSyncToFs;
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
