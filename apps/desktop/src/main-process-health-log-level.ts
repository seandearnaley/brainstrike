export interface MainProcessHealthSample {
  readonly loopLagMaxMs: number;
  readonly loopLagP99Ms: number;
}

export function isMainProcessHealthDegraded(sample: MainProcessHealthSample): boolean {
  return sample.loopLagP99Ms > 100 || sample.loopLagMaxMs > 500;
}
