export interface WindowsProcessIdentity {
  /** Lossless decimal native creation FILETIME from the trusted wrapper itself. */
  readonly creationTime: string;
  readonly pid: number;
}

/** Native live-process FILETIME, or null for a missing/exited PID. Other failures throw. */
export function getProcessCreationTime(pid: number): string | null;
/**
 * Settles when the process `pid`, started at `creationTime` (from getProcessCreationTime), has
 * exited: at once if it already has or the PID names another process, otherwise when the OS
 * signals its handle. Windows only.
 */
export function waitForProcessExit(pid: number, creationTime: string): Promise<void>;

export interface CommandJob {
  /** Verify the wrapper's private READY identity on an opened handle before assignment. */
  assign(identity: WindowsProcessIdentity): void;
  /** Release only after proved join, or a never-assigned Job's fresh empty proof. */
  close(): void;
  /**
   * Stop admissions, terminate the whole private Job, physically join pinned
   * members and prove fresh zero membership/accounting. Calls share one Promise;
   * rejection retains the Job and physical handles, with no automatic retry.
   */
  terminateAndWait(exitCode: number): Promise<void>;
}

/** Windows only; the caller stays outside the new non-inheritable kill-on-close Job. */
export function createCommandJob(): CommandJob;
/** Windows only; call in the trusted wrapper and carry over its private READY IPC. */
export function getCurrentProcessIdentity(): WindowsProcessIdentity;

export function activeProcessCount(): number;
/**
 * Joins this process to a new kill-on-close Job, so the whole tree ends with it. A child stays
 * in the Job unless it is created with CREATE_BREAKAWAY_FROM_JOB, as `launchOutsideJob` does.
 * Windows only.
 */
export function initialize(): void;
/**
 * Starts `executable` with `args` outside this process's Job, so the Job's kill-on-close does
 * not end it: detached, with no inherited handles, this process's environment and `cwd` (this
 * process's working directory when omitted). Returns its pid. Throws the Windows error when
 * CreateProcessW fails, including when this process's own Job forbids breakaway. It also leaves
 * each enclosing Job that allows breakaway, up to the first that does not. Windows only.
 */
export function launchOutsideJob(executable: string, args: readonly string[], cwd?: string): number;
export function terminateOtherProcesses(exitCode: number): number;
