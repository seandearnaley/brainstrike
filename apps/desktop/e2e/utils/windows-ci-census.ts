import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CensusSample, machineCpuDelta, ProcessCpuSamples } from './windows-ci-census-samples';

// PROOF ONLY. WMI at the boundaries; one persistent GetProcesses sampler while the fixture lives.
const enabled =
  process.platform === 'win32' && process.env['BRAINSTRIKE_PROOF_LAUNCH_TIMING'] === '1';
const run = promisify(execFile);
interface ProcessRow {
  readonly a: string | null;
  readonly n: string;
  readonly p: number;
  readonly pp: number;
  readonly s: string | null;
  readonly x: string | null;
}
const SNAPSHOT = `
$ErrorActionPreference = 'Stop'
@(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name
    s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    x = $_.ExecutablePath; a = $_.CommandLine }
}) | ConvertTo-Json -Compress -Depth 2
`;
const SAMPLER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($true) {
  $began = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $unreadable = [System.Collections.Generic.List[int]]::new()
  $rows = @(foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
    try {
      if ($p.Id -eq 0) { continue }
      $start = [DateTimeOffset]::new($p.StartTime.ToUniversalTime())
      [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName
        start = $start.Ticks.ToString(); startedAt = $start.ToUnixTimeMilliseconds()
        cpuMs = $p.TotalProcessorTime.TotalMilliseconds }
    } catch { $unreadable.Add($p.Id) } finally { $p.Dispose() }
  })
  $ended = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stopped = Test-Path -LiteralPath $env:BRAINSTRIKE_PROOF_CENSUS_STOP
  [Console]::WriteLine((ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{
    beganAt = $began; endedAt = $ended; processes = $rows; stopped = $stopped
    samplerPid = $PID; samplerCpuMs = ($rows | Where-Object { $_.pid -eq $PID } | Select-Object -First 1).cpuMs
    unreadablePids = @($unreadable.ToArray())
  })))
  if ($stopped) { break }
  Start-Sleep -Milliseconds ([Math]::Max(1, 1000 - ($ended - $began)))
}
`;
function args(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}
async function snapshot() {
  const beganAt = Date.now();
  const { stdout } = await run('powershell.exe', args(SNAPSHOT), {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  const rows = JSON.parse(stdout) as ProcessRow[] | ProcessRow;
  return { beganAt, endedAt: Date.now(), rows: Array.isArray(rows) ? rows : [rows] };
}
function appProcesses(rows: readonly ProcessRow[]) {
  return rows
    .filter((row) => row.x?.toLowerCase().includes('\\win-unpacked\\'))
    .map((row) => ({
      name: row.n,
      pid: row.p,
      ppid: row.pp,
      started: row.s,
      type: /--type=(\S+)/u.exec(row.a ?? '')?.[1] ?? 'browser',
      utility: /--utility-sub-type=(\S+)/u.exec(row.a ?? '')?.[1],
    }));
}
function busyTimes() {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    busy += times.user + times.nice + times.sys + times.irq;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { busy, total };
}
function print(phase: string, fields: object) {
  console.log(`[win-census] ${phase} ${JSON.stringify(fields)}`);
}
async function startSampler(title: string) {
  const directory = await mkdtemp(join(os.tmpdir(), 'bs-census-'));
  const stopPath = join(directory, 'stop');
  const first = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const samples = new ProcessCpuSamples();
  let buffer = '';
  let failure: unknown;
  let frameCount = 0;
  let stopRequested = false;
  let stopAcknowledged = false;
  let firstBeganAt: number | undefined;
  let lastEndedAt: number | undefined;
  let previousMachine = busyTimes();
  let previousReceiptAt = Date.now();
  const child = execFile(
    'powershell.exe',
    args(SAMPLER),
    {
      env: { ...process.env, ['BRAINSTRIKE_PROOF_CENSUS_STOP']: stopPath },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
    (error) => {
      if (
        failure !== undefined ||
        error ||
        buffer.trim() ||
        frameCount === 0 ||
        !stopRequested ||
        !stopAcknowledged
      ) {
        const cause =
          failure ??
          error ??
          new Error(
            'Census sampler exited before stop, or ended with an incomplete/missing frame.'
          );
        first.reject(cause);
        done.reject(cause);
        return;
      }
      done.resolve();
    }
  );
  // The fixture joins both promises below; early child failure is owned from creation.
  done.promise.catch((cause) => {
    failure ??= cause;
  });
  const startupTimer = setTimeout(() => {
    failure = new Error('Census sampler did not produce its baseline within 30 s.');
    child.kill();
  }, 30_000);
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line) as CensusSample;
        stopAcknowledged ||= frame.stopped === true;
        const receiptAt = Date.now();
        const machine = busyTimes();
        const processCpu = samples.sample(frame);
        firstBeganAt ??= frame.beganAt;
        lastEndedAt = frame.endedAt;
        print('sample', {
          ...processCpu,
          beganAt: frame.beganAt,
          endedAt: frame.endedAt,
          enumerationMs: frame.endedAt - frame.beganAt,
          fixture: title,
          frame: ++frameCount,
          machineAtReceipt: {
            from: previousReceiptAt,
            to: receiptAt,
            ...machineCpuDelta(previousMachine, machine),
          },
          readableProcessCount: frame.processes.length,
          receiptAt,
          samplerCpuMs: frame.samplerCpuMs,
          samplerPid: frame.samplerPid,
          stopped: frame.stopped,
          unreadablePids: frame.unreadablePids,
        });
        previousMachine = machine;
        previousReceiptAt = receiptAt;
        first.resolve();
      } catch (cause) {
        failure = cause;
        child.kill();
      }
    }
  });
  const stop = async () => {
    stopRequested = true;
    const failures: unknown[] = [];
    const timer = setTimeout(() => {
      failure = new Error('Census sampler did not stop within 10 s of the fixture end.');
      child.kill();
    }, 10_000);
    try {
      await writeFile(stopPath, 'stop');
    } catch (cause) {
      failures.push(cause);
      child.kill();
    }
    const settled = await Promise.allSettled([done.promise]);
    clearTimeout(timer);
    const cleanup = await Promise.allSettled([rm(directory, { force: true, recursive: true })]);
    for (const result of [...settled, ...cleanup]) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
      }
    }
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Census stop failed.');
    }
    return { firstBeganAt, frameCount, lastEndedAt, ...samples.totals() };
  };
  try {
    await first.promise;
  } catch (cause) {
    const settled = await Promise.allSettled([done.promise]);
    const cleanup = await Promise.allSettled([rm(directory, { force: true, recursive: true })]);
    const failures = [cause];
    for (const result of [...settled, ...cleanup]) {
      if (result.status === 'rejected' && result.reason !== cause) {
        failures.push(result.reason);
      }
    }
    throw failures.length === 1 ? cause : new AggregateError(failures, 'Census startup failed.');
  } finally {
    clearTimeout(startupTimer);
  }
  return stop;
}
export async function beginWindowsCiCensus(title: string) {
  if (!enabled) {
    return null;
  }
  const before = await snapshot();
  const stop = await startSampler(title);
  const beganAt = Date.now();
  print('before', {
    beganAt,
    fixture: title,
    packagedAppProcesses: appProcesses(before.rows),
    processCount: before.rows.length,
    snapshot: { beganAt: before.beganAt, endedAt: before.endedAt },
  });
  return { beganAt, machine: busyTimes(), stop, title };
}
export async function endWindowsCiCensus(census: Awaited<ReturnType<typeof beginWindowsCiCensus>>) {
  if (!census) {
    return;
  }
  // This edge is after fixture teardown, not necessarily Main's exit. Stop sampling before the final WMI query.
  const endedAt = Date.now();
  const machine = machineCpuDelta(census.machine, busyTimes());
  const observation = await census.stop();
  const after = await snapshot();
  const report = {
    beganAt: census.beganAt,
    endedAt,
    fixture: census.title,
    machine,
    observation,
    packagedAppProcesses: appProcesses(after.rows),
    snapshot: { beganAt: after.beganAt, endedAt: after.endedAt },
  };
  print('after-fixture', report);
  return report;
}
