import { performance } from 'node:perf_hooks';

const BOOT_MEASUREMENT_START_ENV = 'BRAINSTRIKE_BOOT_MEASURE_START_MS';
const QUIT_AFTER_BOOT_MEASUREMENT_ENV = 'BRAINSTRIKE_BOOT_MEASURE_QUIT_AFTER_LISTEN';

export type BootMeasurementMark = 'agent-host-ready' | 'app-ready';

/**
 * Emits an opt-in, machine-readable boot marker for the BST-1064 measurement
 * harness. The parent supplies its wall-clock spawn timestamp so the reported
 * duration includes process creation and Electron/Node bootstrap time.
 *
 * `isPackaged` (pass `app.isPackaged`) makes this scaffolding provably
 * unreachable in a shipped build: a stray env var in a user's environment must
 * never alter a packaged boot — not by emitting marker lines and not by
 * throwing. The strict-validation rules below therefore apply only to
 * unpackaged (dev/harness) launches, which are the only place the harness runs.
 *
 * An unset or empty-string env var means "measurement mode is off" (a normal
 * production boot never sets this, and an empty-value assignment — the
 * `NO_COLOR=` idiom used elsewhere in this repo's e2e scripts — must behave
 * the same as unset, not as "0"). A genuinely malformed non-empty value
 * (e.g. a typo) still throws: silently no-op'ing on bad input would hide the
 * mistake instead of surfacing it.
 */
export function emitBootMeasurementMark(mark: BootMeasurementMark, isPackaged: boolean): void {
  if (isPackaged) {
    return;
  }
  const rawStartMs = process.env[BOOT_MEASUREMENT_START_ENV];
  if (rawStartMs === undefined || rawStartMs === '') {
    return;
  }

  const startMs = Number(rawStartMs);
  if (!Number.isFinite(startMs) || startMs <= 0) {
    throw new Error(`${BOOT_MEASUREMENT_START_ENV} must be a positive finite number.`);
  }

  const elapsedMs = performance.timeOrigin + performance.now() - startMs;
  process.stdout.write(`BOOT_MARK ${mark} ${elapsedMs.toFixed(3)}\n`);
}

/**
 * Whether main should quit at the agent-host-ready mark, before any window work,
 * for the boot-measurement harness. Always false in a packaged build (pass
 * `app.isPackaged`): the quit-after-measurement kill switch booting a shipped app
 * to "started, then exited 0 with no window" would read as "I double-clicked
 * BrainStrike and nothing happened". Unpackaged launches share the same
 * strictness rule as {@link emitBootMeasurementMark}: unset or empty means
 * "off"; the one accepted "on" value is `'1'`; anything else (e.g. a human
 * hand-running the harness's documented follow-up steps with `=true` or
 * `=yes`) throws rather than silently running a full boot that never quits.
 */
export function shouldQuitAfterBootMeasurement(isPackaged: boolean): boolean {
  if (isPackaged) {
    return false;
  }
  const raw = process.env[QUIT_AFTER_BOOT_MEASUREMENT_ENV];
  if (raw === undefined || raw === '') {
    return false;
  }
  if (raw === '1') {
    return true;
  }
  throw new Error(
    `${QUIT_AFTER_BOOT_MEASUREMENT_ENV} must be unset or "1" (got ${JSON.stringify(raw)}).`
  );
}
