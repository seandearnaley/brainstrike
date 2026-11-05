/**
 * Whether this host can run code inside the OS fence, answered without loading
 * the fence executor (BST-2438): admission asks before offering run_python, and
 * the executor loads only when a fenced command or execution runs.
 */
import { platform } from 'node:process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

/**
 * The explicit `darwin`/`linux` list is LOAD-BEARING and must not be
 * "simplified" to `SandboxManager.isSupportedPlatform()` alone (BST-1068).
 *
 * srt's own probe returns TRUE on Windows — its Windows fence is real (a
 * dedicated `srt-sandbox` account, kernel WFP filters, NTFS DACLs) — and
 * `currentExecPlatform()` already accepts `'win32'`. So dropping this literal
 * would silently enable Windows with a truthful `os-fence` capability and a
 * QUIETLY WRONG filesystem policy: Windows srt fixes filesystem scope at
 * `initialize()` and supports neither the per-execution `updateConfig` nor the
 * per-command config override this executor relies on, so every execution
 * after the first would run under the first execution's policy while claiming
 * to honour its own. That is the exact silent degradation the seam forbids,
 * and it would present as a working sandbox.
 *
 * Windows stays unavailable until the mechanism can express a per-execution
 * `ExecPolicy` — not merely until it is out of alpha.
 */
export function isFenceSupported(): boolean {
  return (platform === 'darwin' || platform === 'linux') && SandboxManager.isSupportedPlatform();
}
