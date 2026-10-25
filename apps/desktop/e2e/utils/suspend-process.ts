import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Freeze every thread of process `pid` until it is killed, so it reads nothing
 * more from its pipes and ports. POSIX stops it with SIGSTOP. Windows has no
 * stop signal, so its threads are suspended through `NtSuspendProcess`, the call
 * Sysinternals PsSuspend makes; the suspension outlives the PowerShell that made
 * it, and TerminateProcess (`process.kill(pid, 'SIGKILL')`) still ends the process.
 * Resolves once the process is frozen; throws when it could not be.
 */
export async function suspendProcess(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGSTOP');
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot suspend process ${pid}`);
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace BrainstrikeE2E -Name Nt -MemberDefinition '",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
    '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);',
    '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);',
    "'",
    // PROCESS_SUSPEND_RESUME
    `$handle = [BrainstrikeE2E.Nt]::OpenProcess(0x0800, $false, ${pid})`,
    'if ($handle -eq [IntPtr]::Zero) { throw "OpenProcess(' +
      pid +
      ') failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
    'try {',
    '  $status = [BrainstrikeE2E.Nt]::NtSuspendProcess($handle)',
    `  if ($status -ne 0) { throw ('NtSuspendProcess(${pid}) failed: 0x{0:X8}' -f $status) }`,
    '} finally { [void][BrainstrikeE2E.Nt]::CloseHandle($handle) }',
  ].join('\n');
  // -EncodedCommand (UTF-16LE base64) carries the script past command-line quoting intact.
  await run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]);
}
