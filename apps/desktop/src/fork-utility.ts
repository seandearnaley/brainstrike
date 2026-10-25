import { type ForkOptions, type UtilityProcess, utilityProcess } from 'electron';

/**
 * Every Electron utility Main starts (ADR-0030). Its stdout and stderr are piped and copied to
 * Main's own: an inherited stream reached nothing on Windows (no agent host line in any app
 * output log), and a utility's log is the only evidence of why it stalled.
 */
export function forkUtility(
  modulePath: string,
  args: readonly string[],
  options: Omit<ForkOptions, 'stdio'>
): UtilityProcess {
  const child = utilityProcess.fork(modulePath, [...args], { ...options, stdio: 'pipe' });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  return child;
}
