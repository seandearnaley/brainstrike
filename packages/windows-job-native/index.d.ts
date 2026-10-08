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
