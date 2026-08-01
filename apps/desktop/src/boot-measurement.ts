import { performance } from 'node:perf_hooks';

const BOOT_MEASUREMENT_START_ENV = 'BRAINSTRIKE_BOOT_MEASURE_START_MS';

export type BootMeasurementMark = 'app-ready' | 'assistant-listening';

/**
 * Emits an opt-in, machine-readable boot marker for the BST-1064 measurement
 * harness. The parent supplies its wall-clock spawn timestamp so the reported
 * duration includes process creation and Electron/Node bootstrap time.
 */
export function emitBootMeasurementMark(mark: BootMeasurementMark): void {
  const rawStartMs = process.env[BOOT_MEASUREMENT_START_ENV];
  if (rawStartMs === undefined) {
    return;
  }

  const startMs = Number(rawStartMs);
  if (!Number.isFinite(startMs) || startMs <= 0) {
    throw new Error(`${BOOT_MEASUREMENT_START_ENV} must be a positive finite number.`);
  }

  const elapsedMs = performance.timeOrigin + performance.now() - startMs;
  process.stdout.write(`BOOT_MARK ${mark} ${elapsedMs.toFixed(3)}\n`);
}
