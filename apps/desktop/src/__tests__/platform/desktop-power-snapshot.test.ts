import { describe, expect, it, vi } from 'vitest';
import { readDesktopPowerSnapshot } from '../../platform/desktop-power-snapshot';

describe('readDesktopPowerSnapshot', () => {
  it('maps Electron powerMonitor values into workspace index QoS inputs', () => {
    const snapshot = readDesktopPowerSnapshot(
      {
        getCurrentThermalState: vi.fn(() => 'serious'),
        getSystemIdleState: vi.fn(() => 'idle'),
        getSystemIdleTime: vi.fn(() => 90),
        isOnBatteryPower: vi.fn(() => true),
      },
      () => 1234
    );

    expect(snapshot).toEqual({
      idleState: 'idle',
      idleTimeMs: 90_000,
      powerSource: 'battery',
      sampledAt: 1234,
      thermalState: 'serious',
    });
  });

  it('throws on invalid Electron idle state instead of guessing', () => {
    expect(() =>
      readDesktopPowerSnapshot({
        getSystemIdleState: vi.fn(() => 'sleeping'),
        getSystemIdleTime: vi.fn(() => 1),
        isOnBatteryPower: vi.fn(() => false),
      })
    ).toThrow('Electron powerMonitor returned invalid idle state: sleeping');
  });

  it('throws on invalid Electron thermal state instead of guessing', () => {
    expect(() =>
      readDesktopPowerSnapshot({
        getCurrentThermalState: vi.fn(() => 'hot'),
        getSystemIdleState: vi.fn(() => 'active'),
        getSystemIdleTime: vi.fn(() => 1),
        isOnBatteryPower: vi.fn(() => false),
      })
    ).toThrow('Electron powerMonitor returned invalid thermal state: hot');
  });
});
