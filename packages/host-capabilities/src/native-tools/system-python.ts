/**
 * The standalone CLI's Python (owner decision, 2026-11-01): the system Python 3
 * the person installed, where Desktop runs its bundled CPython. Each launch
 * names an interpreter path, so this asks the candidate itself for
 * `sys.executable`: the Windows `py` launcher answers with the install it
 * selects, and a `python` that is Python 2 or a Store alias answers nothing
 * usable and is not chosen.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Candidates in the platform's documented order. On Windows the `py` command
 * (the Python install manager's, or the legacy launcher's) selects an
 * installed Python 3; `python3` there is a compatibility alias python.org does
 * not recommend. Elsewhere `python3` is the canonical name.
 */
function systemPythonCandidates(): readonly (readonly [string, ...string[]])[] {
  return process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
}

/** `-I` keeps the probe from importing anything beside the host's working directory. */
const PROBE = [
  '-I',
  '-c',
  'import sys; sys.exit(3) if sys.version_info[0] != 3 else sys.stdout.write(sys.executable)',
];

/** No Python 3 on this machine; run_python reports its `python_*` code as `interpreter_unavailable`. */
export class SystemPythonUnavailableError extends Error {
  readonly code = 'python_not_found';
}

/** Why one candidate did not answer: absent, not Python 3, or its own first error line. */
function probeFailure(error: unknown): string {
  // execFile's error carries the spawn errno, or the exit code, as `code`.
  const failure = error as Error & { code?: unknown; stderr?: unknown };
  if (failure.code === 'ENOENT') {
    return 'not found';
  }
  if (failure.code === 3) {
    return 'not Python 3';
  }
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  return stderr.split('\n', 1)[0] || failure.message;
}

/**
 * The absolute path of the system Python 3, asked of each candidate in order.
 * None answering is a visible, actionable refusal naming what was tried.
 */
export async function resolveSystemPython(signal?: AbortSignal): Promise<string> {
  const tried: string[] = [];
  for (const [command, ...args] of systemPythonCandidates()) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await execFileAsync(command, [...args, ...PROBE], {
        encoding: 'utf8',
        ...(signal ? { signal } : {}),
        windowsHide: true,
      });
      if (stdout !== '') {
        return stdout;
      }
      tried.push(`${[command, ...args].join(' ')} (no interpreter path)`);
    } catch (error) {
      signal?.throwIfAborted();
      tried.push(`${[command, ...args].join(' ')} (${probeFailure(error)})`);
    }
  }
  throw new SystemPythonUnavailableError(
    `No Python 3 interpreter was found on PATH; tried ${tried.join(', ')}. ${
      process.platform === 'win32'
        ? 'Install Python 3 from python.org, which provides the `py` command,'
        : 'Install Python 3 so `python3` is on the host’s PATH,'
    } then retry.`
  );
}
