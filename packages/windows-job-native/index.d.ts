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
