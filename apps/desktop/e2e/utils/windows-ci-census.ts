import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

/**
 * PROOF ONLY (windows-smoke-sweep3, not for merge). Per test on Windows CI:
 * every process's CPU time before the launch and after Main's exit, the
 * machine's busy share each second in between, and every packaged-app process
 * alive at either edge. An app process alive before a launch or after Main's
 * exit outlived its owner. Off unless BRAINSTRIKE_PROOF_LAUNCH_TIMING=1.
 */
const enabled =
  process.platform === 'win32' && process.env['BRAINSTRIKE_PROOF_LAUNCH_TIMING'] === '1';
const run = promisify(execFile);
const APP_PATH = '\\win-unpacked\\';
const TOP = 12;

interface ProcessRow {
  /** Command line, truncated. */
  readonly a: string | null;
  /** CPU ms (kernel + user). */
  readonly c: number;
  readonly n: string;
  readonly p: number;
  readonly pp: number;
  /** Creation time, ISO. */
  readonly s: string | null;
  readonly x: string | null;
}

const SNAPSHOT = `
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process | ForEach-Object {
  $cmd = $_.CommandLine
  [pscustomobject]@{
    p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name
    c = [int64](($_.KernelModeTime + $_.UserModeTime) / 10000)
    s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    x = $_.ExecutablePath
    a = if ($cmd) { $cmd.Substring(0, [Math]::Min(240, $cmd.Length)) } else { $null }
  }
} | ConvertTo-Json -Compress -Depth 2
`;

const DEFENDER = `
try {
  $s = Get-MpComputerStatus
  $p = Get-MpPreference
  [pscustomobject]@{
    realTime = $s.RealTimeProtectionEnabled; onAccess = $s.OnAccessProtectionEnabled
    behavior = $s.BehaviorMonitorEnabled; exclusions = $p.ExclusionPath
    scanAvgCpu = $p.ScanAvgCPULoadFactor
  } | ConvertTo-Json -Compress
} catch { 'defender status unavailable: ' + $_.Exception.Message }
`;

async function powershell(script: string): Promise<string> {
  // UTF-16LE base64: no command-line quoting of the script's text.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true }
  );
  return stdout;
}

async function snapshot(): Promise<ProcessRow[]> {
  const rows = JSON.parse(await powershell(SNAPSHOT)) as ProcessRow[] | ProcessRow;
  return Array.isArray(rows) ? rows : [rows];
}

function key(row: ProcessRow): string {
  return `${row.p}@${row.s ?? ''}`;
}

function appProcesses(rows: readonly ProcessRow[]): unknown[] {
  return rows
    .filter((row) => row.x?.toLowerCase().includes(APP_PATH))
    .map((row) => ({
      cpuMs: row.c,
      pid: row.p,
      ppid: row.pp,
      started: row.s,
      type: /--type=(\S+)/.exec(row.a ?? '')?.[1] ?? 'browser',
      utility: /--utility-sub-type=(\S+)/.exec(row.a ?? '')?.[1],
    }));
}

function busyTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { idle, irq, nice, sys, user } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

function print(line: string, fields: Record<string, unknown>): void {
  console.log(`[win-census] ${line} ${JSON.stringify(fields)}`);
}

let defenderReported = false;

export interface WindowsCiCensus {
  readonly before: readonly ProcessRow[];
  readonly busyPerSecond: number[];
  readonly startedAt: number;
  readonly timer: ReturnType<typeof setInterval>;
  readonly title: string;
}

/** Before the launch: the machine's processes, and any app process already alive. */
export async function beginWindowsCiCensus(title: string): Promise<WindowsCiCensus | null> {
  if (!enabled) {
    return null;
  }
  if (!defenderReported) {
    defenderReported = true;
    print('defender', { status: (await powershell(DEFENDER)).trim() });
  }
  const before = await snapshot();
  const lingering = appProcesses(before);
  print(`before ${title}`, {
    lingeringAppProcesses: lingering,
    processCount: before.length,
  });
  const busyPerSecond: number[] = [];
  let previous = busyTimes();
  const timer = setInterval(() => {
    const current = busyTimes();
    const total = current.total - previous.total;
    busyPerSecond.push(total > 0 ? Math.round((100 * (current.busy - previous.busy)) / total) : 0);
    previous = current;
  }, 1000);
  timer.unref();
  return { before, busyPerSecond, startedAt: Date.now(), timer, title };
}

/** After Main's exit: who used the CPU during the test, and any app process still alive. */
export async function endWindowsCiCensus(census: WindowsCiCensus | null): Promise<void> {
  if (!census) {
    return;
  }
  clearInterval(census.timer);
  const after = await snapshot();
  const wallMs = Date.now() - census.startedAt;
  const beforeCpu = new Map(census.before.map((row) => [key(row), row.c]));
  const deltas = after
    .map((row) => ({
      cpuMs: row.c - (beforeCpu.get(key(row)) ?? 0),
      name: row.n,
      new: !beforeCpu.has(key(row)),
      pid: row.p,
    }))
    .filter((row) => row.cpuMs > 0)
    .sort((left, right) => right.cpuMs - left.cpuMs);
  // Processes that ran and exited during the test are absent from both snapshots;
  // their share is the machine total minus what the survivors account for.
  const survivorsCpuMs = deltas.reduce((sum, row) => sum + row.cpuMs, 0);
  const machineCpuMs = Math.round(
    (wallMs * os.cpus().length * census.busyPerSecond.reduce((sum, value) => sum + value, 0)) /
      (100 * Math.max(1, census.busyPerSecond.length))
  );
  print(`after ${census.title}`, {
    busyPerSecond: census.busyPerSecond.join(','),
    cores: os.cpus().length,
    machineCpuMsEstimate: machineCpuMs,
    orphanAppProcesses: appProcesses(after),
    survivorsCpuMs,
    top: deltas.slice(0, TOP),
    wallMs,
  });
}
