import { describe, expect, it } from 'vitest';
import { shouldNotify } from '../notifications/should-notify';

const baseSettings = {
  events: { runFailed: true, runFinished: true, toolApprovalRequired: true },
  masterEnabled: true,
};

const unfocusedHidden = { hasFocus: false, visibilityState: 'hidden' as const };
const unfocusedVisibleNoFocus = { hasFocus: false, visibilityState: 'visible' as const };
const focused = { hasFocus: true, visibilityState: 'visible' as const };

describe('shouldNotify', () => {
  it('allows a notification when master + event are on, permission granted, and the tab is hidden', () => {
    expect(
      shouldNotify({
        focusState: unfocusedHidden,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: baseSettings,
      })
    ).toBe(true);
  });

  it('allows a notification when the tab is visible but the window lacks focus', () => {
    expect(
      shouldNotify({
        focusState: unfocusedVisibleNoFocus,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: baseSettings,
      })
    ).toBe(true);
  });

  it('never notifies a focused, visible user', () => {
    expect(
      shouldNotify({
        focusState: focused,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: baseSettings,
      })
    ).toBe(false);
  });

  it('refuses when the master toggle is off', () => {
    expect(
      shouldNotify({
        focusState: unfocusedHidden,
        kind: 'runFinished',
        permissionState: 'granted',
        settings: { ...baseSettings, masterEnabled: false },
      })
    ).toBe(false);
  });

  it('refuses when the specific event toggle is off', () => {
    expect(
      shouldNotify({
        focusState: unfocusedHidden,
        kind: 'runFailed',
        permissionState: 'granted',
        settings: { ...baseSettings, events: { ...baseSettings.events, runFailed: false } },
      })
    ).toBe(false);
  });

  it('refuses when permission is denied', () => {
    expect(
      shouldNotify({
        focusState: unfocusedHidden,
        kind: 'runFinished',
        permissionState: 'denied',
        settings: baseSettings,
      })
    ).toBe(false);
  });

  it('refuses when permission is default (not yet granted)', () => {
    expect(
      shouldNotify({
        focusState: unfocusedHidden,
        kind: 'runFinished',
        permissionState: 'default',
        settings: baseSettings,
      })
    ).toBe(false);
  });

  it('refuses when the Notification API is unsupported', () => {
    expect(
      shouldNotify({
        focusState: unfocusedHidden,
        kind: 'runFinished',
        permissionState: 'unsupported',
        settings: baseSettings,
      })
    ).toBe(false);
  });
});
