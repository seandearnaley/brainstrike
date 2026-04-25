export type DatabaseWorkPriority = 'foreground' | 'normal' | 'background';

export interface DatabaseWorkOptions {
  readonly label?: string;
  readonly priority?: DatabaseWorkPriority;
}

export interface DatabaseWorkSchedulerSnapshot {
  readonly backgroundWaiting: boolean;
  readonly backgroundWaitingSince: number | null;
  readonly lastForegroundAt: number | null;
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningLabel: string | null;
  readonly runningPriority: DatabaseWorkPriority | null;
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
  readonly exec?: (
    sql: string,
    params?: unknown[],
    options?: DatabaseWorkOptions
  ) => Promise<unknown>;
  readonly query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: T[] }>;
  readonly raw?: unknown;
  readonly transaction?: <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) => Promise<T>;
}

interface ScheduledTask<T> {
  readonly label: string | null;
  readonly priority: DatabaseWorkPriority;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
  readonly work: () => Promise<T>;
}

type QueuedTask = ScheduledTask<unknown>;

const PRIORITY_ORDER: readonly DatabaseWorkPriority[] = ['foreground', 'normal', 'background'];
const DEFAULT_FOREGROUND_QUIET_MS = 75;
const SCHEDULER_SYMBOL = Symbol.for('brainstrike.databaseWorkScheduler');
const DEFAULT_PRIORITY_SYMBOL = Symbol.for('brainstrike.databaseWorkDefaultPriority');

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
  readonly #queues = createEmptyQueues();
  #backgroundWaitingSince: number | null = null;
  #drainTimer: ReturnType<typeof setTimeout> | null = null;
  #lastForegroundAt: number | null = null;
  #running = false;
  #runningLabel: string | null = null;
  #runningPriority: DatabaseWorkPriority | null = null;

  constructor(options: DatabaseWorkSchedulerOptions = {}) {
    this.#foregroundQuietMs = Math.max(0, options.foregroundQuietMs ?? DEFAULT_FOREGROUND_QUIET_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  getSnapshot(): DatabaseWorkSchedulerSnapshot {
    return {
      backgroundWaiting: this.#backgroundWaitingSince !== null,
      backgroundWaitingSince: this.#backgroundWaitingSince,
      lastForegroundAt: this.#lastForegroundAt,
      queued: createQueuedCounts(this.#queues),
      runningLabel: this.#runningLabel,
      runningPriority: this.#runningPriority,
    };
  }

  run<T>(work: () => Promise<T>, options: DatabaseWorkOptions = {}): Promise<T> {
    const priority = normalizePriority(options.priority);
    if (priority === 'foreground') {
      this.#lastForegroundAt = this.#now();
    }

    return new Promise<T>((resolve, reject) => {
      this.#queues[priority].push({
        label: options.label ?? null,
        priority,
        reject,
        resolve: resolve as (value: unknown) => void,
        work: work as () => Promise<unknown>,
      });
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
      if (priority === 'background') {
        const delayMs = this.#nextDelayMs();
        if (delayMs > 0) {
          if (this.#backgroundWaitingSince === null) {
            this.#backgroundWaitingSince = this.#now();
            this.#emit();
          }
          this.#scheduleDrain(delayMs);
          return null;
        }
      }

      const task = this.#queues[priority].shift();
      if (task) {
        if (priority === 'background' && this.#backgroundWaitingSince !== null) {
          this.#backgroundWaitingSince = null;
        }
        return task;
      }
    }

    if (this.#backgroundWaitingSince !== null) {
      this.#backgroundWaitingSince = null;
    }
    return null;
  }

  #scheduleDrain(delayMs: number): void {
    if (this.#drainTimer !== null) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }

    if (delayMs <= 0) {
      queueMicrotask(() => {
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
      this.#running = false;
      this.#runningPriority = null;
      this.#runningLabel = null;
      this.#emit();
    }

    if (hasQueuedWork(this.#queues)) {
      this.#scheduleDrain(this.#nextDelayMs());
    }
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
  return scheduler && typeof scheduler === 'object' && 'run' in scheduler
    ? (scheduler as DatabaseWorkScheduler)
    : null;
}

function getDefaultPriorityFromHandle(handle: unknown): DatabaseWorkPriority | null {
  if (!handle || typeof handle !== 'object') {
    return null;
  }
  const priority = (handle as { [DEFAULT_PRIORITY_SYMBOL]?: unknown })[DEFAULT_PRIORITY_SYMBOL];
  return priority === 'foreground' || priority === 'normal' || priority === 'background'
    ? priority
    : null;
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
  const scheduledQuery: ScheduledDbHandle['query'] = async <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: DatabaseWorkOptions
  ) =>
    scheduler.run(
      async () => await db.query<T>(sql, params),
      mergeOptions(defaultPriority, options)
    );

  const scheduledExec: ScheduledDbHandle['exec'] | undefined = db.exec
    ? async (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        scheduler.run(
          async () => await db.exec?.(sql, params),
          mergeOptions(defaultPriority, options)
        )
    : undefined;

  const baseTransaction = db.transaction;
  const scheduledTransaction: ScheduledDbHandle['transaction'] | undefined = baseTransaction
    ? async <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) =>
        scheduler.run(
          async () =>
            await baseTransaction(async (tx) => {
              const scheduledTx = createScheduledDbHandle(tx, scheduler, defaultPriority);
              return await fn(scheduledTx);
            }),
          { priority: defaultPriority, label: 'transaction' }
        )
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
      if (property === SCHEDULER_SYMBOL) {
        return scheduler;
      }
      if (property === DEFAULT_PRIORITY_SYMBOL) {
        return defaultPriority;
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
    return createScheduledDbHandle(
      db,
      createDatabaseWorkScheduler({ foregroundQuietMs: 0 }),
      priority
    );
  }

  const prioritizedQuery: ScheduledDbHandle['query'] = async <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: DatabaseWorkOptions
  ) => await db.query<T>(sql, params, mergeOptions(priority, options));

  const prioritizedExec: ScheduledDbHandle['exec'] | undefined = db.exec
    ? async (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        await db.exec?.(sql, params, mergeOptions(priority, options))
    : undefined;

  const baseTransaction = db.transaction;
  const prioritizedTransaction: ScheduledDbHandle['transaction'] | undefined = baseTransaction
    ? async <T>(fn: (tx: ScheduledDbHandle) => Promise<T>) =>
        await baseTransaction(async (tx) => await fn(createPriorityDbHandle(tx, priority)))
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
      if (property === SCHEDULER_SYMBOL) {
        return scheduler;
      }
      if (property === DEFAULT_PRIORITY_SYMBOL) {
        return priority;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
