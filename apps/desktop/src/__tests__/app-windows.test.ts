import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { getAppWindows, isAppWindowSender, trackAppWindow, untrackAppWindow } from '../app-windows';

function createWindow(id: number) {
  return Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    webContents: { id },
  });
}

afterEach(() => {
  for (const window of getAppWindows()) {
    untrackAppWindow(window.webContents.id);
  }
});

describe('app windows', () => {
  it('recognizes a tracked window as a sender', () => {
    const window = createWindow(17);

    trackAppWindow(window as never);

    expect(isAppWindowSender(17)).toBe(true);
    expect(getAppWindows()).toEqual([window]);
  });

  it('does not recognize an untracked sender', () => {
    expect(isAppWindowSender(99_999)).toBe(false);
  });

  it('untracks a closed window after its webContents is destroyed', () => {
    const window = createWindow(23);
    trackAppWindow(window as never);
    window.webContents = undefined as never;

    window.emit('closed');

    expect(isAppWindowSender(23)).toBe(false);
    expect(getAppWindows()).toEqual([]);
  });

  it('registers one closed listener when tracking a window twice', () => {
    const window = createWindow(29);

    trackAppWindow(window as never);
    trackAppWindow(window as never);

    expect(window.listenerCount('closed')).toBe(1);
    expect(getAppWindows()).toEqual([window]);
  });

  it('drops and untracks a destroyed window when listing app windows', () => {
    const live = createWindow(31);
    const destroyed = createWindow(32);
    trackAppWindow(live as never);
    trackAppWindow(destroyed as never);
    destroyed.isDestroyed = () => true;

    expect(getAppWindows()).toEqual([live]);
    expect(isAppWindowSender(32)).toBe(false);
  });

  it('untracks a window explicitly', () => {
    const window = createWindow(41);
    trackAppWindow(window as never);

    untrackAppWindow(41);

    expect(isAppWindowSender(41)).toBe(false);
    expect(getAppWindows()).toEqual([]);
  });
});
