/**
 * Type declarations for the Scheduling APIs
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Scheduler
 */

type Scheduler = {
  /**
   * Yields control to the main thread, allowing the browser to run other tasks.
   * Returns a promise that resolves when it's the task's turn to run again.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
   */
  yield?(): Promise<void>;

  /**
   * Posts a task to run at the given priority.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask
   */
  postTask?<T>(callback: () => T | Promise<T>, options?: SchedulerPostTaskOptions): Promise<T>;
};

type SchedulerPostTaskOptions = {
  /**
   * The priority of the task.
   * - 'user-blocking': High priority, should complete quickly
   * - 'user-visible': Medium priority, should complete soon
   * - 'background': Low priority, can be delayed
   */
  priority?: 'user-blocking' | 'user-visible' | 'background';

  /**
   * An AbortSignal to cancel the task.
   */
  signal?: AbortSignal;

  /**
   * Delay in milliseconds before the task runs.
   */
  delay?: number;
};

declare const scheduler: Scheduler | undefined;
