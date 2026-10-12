import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitBootMeasurementMark, shouldQuitAfterBootMeasurement } from '../boot-measurement';

const START_ENV = 'BRAINSTRIKE_BOOT_MEASURE_START_MS';
const QUIT_ENV = 'BRAINSTRIKE_BOOT_MEASURE_QUIT_AFTER_LISTEN';

afterEach(() => {
  Reflect.deleteProperty(process.env, START_ENV);
  Reflect.deleteProperty(process.env, QUIT_ENV);
  vi.restoreAllMocks();
});

describe('emitBootMeasurementMark', () => {
  it('emits a BOOT_MARK line when unpackaged and the start env is a valid epoch', () => {
    process.env[START_ENV] = String(Date.now() - 50);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    emitBootMeasurementMark('app-ready', false);
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0];
    if (!call) {
      throw new Error('expected stdout write call');
    }
    expect(call[0]).toMatch(/^BOOT_MARK app-ready [0-9]+(?:\.[0-9]+)?\n$/);
  });

  it('is unreachable in a packaged build even with the env var set', () => {
    process.env[START_ENV] = String(Date.now() - 50);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    emitBootMeasurementMark('app-ready', true);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not throw on a malformed value in a packaged build (never alters a shipped boot)', () => {
    process.env[START_ENV] = 'abc';
    expect(() => emitBootMeasurementMark('app-ready', true)).not.toThrow();
  });

  it.each(['', undefined])('treats %j as measurement-off when unpackaged', (value) => {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, START_ENV);
    } else {
      process.env[START_ENV] = value;
    }
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    emitBootMeasurementMark('agent-host-ready', false);
    expect(write).not.toHaveBeenCalled();
  });

  it('throws on a malformed non-empty value when unpackaged', () => {
    process.env[START_ENV] = 'abc';
    expect(() => emitBootMeasurementMark('app-ready', false)).toThrow(START_ENV);
  });
});

describe('shouldQuitAfterBootMeasurement', () => {
  it('returns false in a packaged build even when the flag is "1"', () => {
    process.env[QUIT_ENV] = '1';
    expect(shouldQuitAfterBootMeasurement(true)).toBe(false);
  });

  it('does not throw on a malformed value in a packaged build', () => {
    process.env[QUIT_ENV] = 'true';
    expect(() => shouldQuitAfterBootMeasurement(true)).not.toThrow();
    expect(shouldQuitAfterBootMeasurement(true)).toBe(false);
  });

  it('returns true only for the literal "1" when unpackaged', () => {
    process.env[QUIT_ENV] = '1';
    expect(shouldQuitAfterBootMeasurement(false)).toBe(true);
  });

  it.each(['', undefined])('treats %j as off when unpackaged', (value) => {
    if (value === undefined) {
      delete process.env[QUIT_ENV];
    } else {
      process.env[QUIT_ENV] = value;
    }
    expect(shouldQuitAfterBootMeasurement(false)).toBe(false);
  });

  it('throws on a malformed non-empty value when unpackaged', () => {
    process.env[QUIT_ENV] = 'yes';
    expect(() => shouldQuitAfterBootMeasurement(false)).toThrow(QUIT_ENV);
  });
});
