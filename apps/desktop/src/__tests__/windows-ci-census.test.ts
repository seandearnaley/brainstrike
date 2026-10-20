import { describe, expect, it } from 'vitest';
import {
  type CensusProcess,
  type CensusSample,
  machineCpuDelta,
  ProcessCpuSamples,
} from '../../e2e/utils/windows-ci-census-samples';

function row(pid: number, cpuMs: number, start = 'old', startedAt = 0): CensusProcess {
  return { cpuMs, name: `p${pid}`, pid, start, startedAt };
}
function frame(endedAt: number, processes: CensusProcess[]): CensusSample {
  return { beganAt: endedAt - 10, endedAt, processes, samplerPid: 99, unreadablePids: [] };
}
describe('proof-only Windows CPU sampling', () => {
  it('excludes idle CPU and retains a transient process after it leaves later snapshots', () => {
    const samples = new ProcessCpuSamples();
    samples.sample(frame(1000, [row(0, 20_000), row(1, 100)]));
    expect(samples.sample(frame(2000, [row(0, 21_900), row(1, 150)])).top).toEqual([
      { ...row(1, 50), previousSampleEndedAt: 1000 },
    ]);
    samples.sample(frame(3000, []));
    expect(samples.totals()).toMatchObject({ observedProcessCpuMs: 50, top: [row(1, 50)] });
  });
  it('uses process creation identity so PID reuse cannot inherit another process baseline', () => {
    const samples = new ProcessCpuSamples();
    samples.sample(frame(1000, [row(1, 900)]));
    expect(samples.sample(frame(2000, [row(1, 20, 'new', 1500)])).top).toEqual([
      { ...row(1, 20, 'new', 1500), previousSampleEndedAt: null },
    ]);
  });
  it('does not count pre-test lifetime CPU when an older process becomes readable later', () => {
    const samples = new ProcessCpuSamples();
    samples.sample(frame(1000, []));
    expect(samples.sample(frame(2000, [row(1, 8000)])).top).toEqual([]);
    expect(samples.sample(frame(3000, [row(1, 8100)])).top[0]?.cpuMs).toBe(100);
  });
  it('labels an observation gap and records CPU-counter regression explicitly', () => {
    const samples = new ProcessCpuSamples();
    samples.sample(frame(1000, [row(1, 100)]));
    samples.sample(frame(2000, []));
    expect(samples.sample(frame(3000, [row(1, 150)])).top[0]?.previousSampleEndedAt).toBe(1000);
    expect(samples.sample(frame(4000, [row(1, 10)])).regressedPids).toEqual([1]);
  });
  it('uses actual cumulative machine-counter differences instead of wall time times a rounded mean', () => {
    expect(machineCpuDelta({ busy: 100, total: 1000 }, { busy: 500, total: 3000 })).toEqual({
      busyCpuMs: 400,
      busyPercent: 20,
      totalCpuMs: 2000,
    });
    expect(
      machineCpuDelta({ busy: 100, total: 1000 }, { busy: 50, total: 1000 }).busyPercent
    ).toBeNull();
  });
});
