/** PROOF ONLY. Sampled process CPU is observed work, never a machine-CPU residual. */
export interface CensusProcess {
  readonly cpuMs: number;
  readonly name: string;
  readonly pid: number;
  readonly start: string;
  readonly startedAt: number;
}
export interface CensusSample {
  readonly beganAt: number;
  readonly endedAt: number;
  readonly processes: readonly CensusProcess[];
  readonly samplerCpuMs?: number;
  readonly samplerPid: number;
  readonly stopped?: boolean;
  readonly unreadablePids: readonly number[];
}
export class ProcessCpuSamples {
  readonly #last = new Map<string, { row: CensusProcess; frameEndedAt: number }>();
  readonly #totals = new Map<string, CensusProcess>();
  #baselineAt: number | undefined;
  sample(frame: CensusSample) {
    const baseline = this.#baselineAt;
    this.#baselineAt ??= frame.endedAt;
    const deltas: (CensusProcess & { previousSampleEndedAt: number | null })[] = [];
    const regressedPids: number[] = [];
    for (const row of frame.processes) {
      if (row.pid === 0) {
        continue; // Windows' System Idle Process is idle time, never consumed CPU.
      }
      const key = `${row.pid}@${row.start}`;
      const previous = this.#last.get(key);
      this.#last.set(key, { frameEndedAt: frame.endedAt, row });
      // A newly observed older process has no measured baseline. Do not count its lifetime CPU.
      const from =
        previous?.row.cpuMs ??
        (baseline !== undefined && row.startedAt >= baseline ? 0 : row.cpuMs);
      const cpuMs = row.cpuMs - from;
      if (cpuMs < 0) {
        regressedPids.push(row.pid);
        continue;
      }
      if (cpuMs === 0) {
        continue;
      }
      deltas.push({ ...row, cpuMs, previousSampleEndedAt: previous?.frameEndedAt ?? null });
      this.#totals.set(key, { ...row, cpuMs: (this.#totals.get(key)?.cpuMs ?? 0) + cpuMs });
    }
    return { regressedPids, top: deltas.sort((a, b) => b.cpuMs - a.cpuMs).slice(0, 12) };
  }
  totals() {
    const rows = [...this.#totals.values()];
    return {
      observedProcessCpuMs: rows.reduce((sum, row) => sum + row.cpuMs, 0),
      top: rows.sort((a, b) => b.cpuMs - a.cpuMs).slice(0, 12),
    };
  }
}
export interface CpuCounters {
  readonly busy: number;
  readonly total: number;
}
export function machineCpuDelta(before: CpuCounters, after: CpuCounters) {
  const busyCpuMs = after.busy - before.busy;
  const totalCpuMs = after.total - before.total;
  return {
    busyCpuMs,
    busyPercent:
      totalCpuMs > 0 && busyCpuMs >= 0 && busyCpuMs <= totalCpuMs
        ? (100 * busyCpuMs) / totalCpuMs
        : null,
    totalCpuMs,
  };
}
