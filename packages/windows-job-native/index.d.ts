export interface WindowsProcessIdentity {
  /** Lossless decimal native creation FILETIME from the trusted wrapper itself. */
  readonly creationTime: string;
  readonly pid: number;
}

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
 * After the surviving guard stops admissions, terminate and physically join the
 * other members of its initialized Job. Resolves only when fresh membership and
 * accounting prove the guard alone; rejection is not proof of cleanup. This is
 * not cancellable, and an outer deadline must never permit Root release.
 */
export function drainOtherProcesses(exitCode: number): Promise<void>;
export function initialize(): void;
export function terminateOtherProcesses(exitCode: number): number;

export type LinuxProcessObservation =
  | { readonly state: 'live' | 'exited'; readonly pid: number; readonly start: string }
  | { readonly state: 'missing'; readonly pid: number };
/**
 * Immediately observe one Linux process thread group using one flags0 pidfd.
 * readStart is the trusted existing synchronous C/UTC lstart reader in the
 * caller's active PID namespace. It runs while that pidfd remains owned.
 * Unknown metadata, a different start, unsupported OS/syscalls, poll and close
 * failures throw. Missing is not positive historical-owner retirement proof.
 * Matching strings preserve second-resolution identity only; this does not
 * strengthen an old lease or prove process-group/native-borrower extinction.
 * Never use this observation alone to authorize stale Root recovery.
 */
export function observeLinuxProcess(
  pid: number,
  expectedStart: string,
  readStart: (pid: number) => string | null
): LinuxProcessObservation;
