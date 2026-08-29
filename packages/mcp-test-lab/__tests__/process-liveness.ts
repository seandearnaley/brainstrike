export function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}
