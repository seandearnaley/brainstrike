import { describe, expect, it } from 'vitest';
import { shouldNotify } from '../notifications/should-notify';

const baseSettings = {
  events: {
    prChecks: true,
    prOpened: true,
    runFailed: true,
    runFinished: true,
    toolApprovalRequired: true,
  },
  masterEnabled: true,
};

describe('shouldNotify', () => {
  it('allows a notification when master + event are on, permission granted, and the app is not active', () => {
    expect(
      shouldNotify({
        appActive: false,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: baseSettings,
      })
    ).toBe(true);
  });

  it('never notifies while the app is active (visible and focused)', () => {
    expect(
      shouldNotify({
        appActive: true,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: baseSettings,
      })
    ).toBe(false);
  });

  it('refuses when the master toggle is off', () => {
    expect(
      shouldNotify({
        appActive: false,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: { ...baseSettings, masterEnabled: false },
      })
    ).toBe(false);
  });

  it('refuses when the specific event toggle is off', () => {
    expect(
      shouldNotify({
        appActive: false,
        kind: 'runFailed',
        permissionState: 'granted',
        settings: { ...baseSettings, events: { ...baseSettings.events, runFailed: false } },
      })
    ).toBe(false);
  });

  it('refuses when permission is denied', () => {
    expect(
      shouldNotify({
        appActive: false,
        kind: 'runFinished',
        permissionState: 'denied',
        settings: baseSettings,
      })
    ).toBe(false);
  });

  it('refuses when permission is default (not yet granted)', () => {
    expect(
      shouldNotify({
        appActive: false,
        kind: 'runFinished',
        permissionState: 'default',
        settings: baseSettings,
      })
    ).toBe(false);
  });

  it('refuses when the Notification API is unsupported', () => {
    expect(
      shouldNotify({
        appActive: false,
        kind: 'runFinished',
        permissionState: 'unsupported',
        settings: baseSettings,
      })
    ).toBe(false);
  });
});
