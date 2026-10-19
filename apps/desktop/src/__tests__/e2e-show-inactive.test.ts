import { describe, expect, it } from 'vitest';
import { e2eShowInactive } from '../../e2e/utils/e2e-show-inactive';

describe('E2E test-window visibility', () => {
  it('shows the test window unfocused on Linux CI: X11 renders a never-mapped window at 1 fps (BST-2040)', () => {
    expect(e2eShowInactive({ CI: 'true' }, 'linux')).toBe('1');
  });

  it('shows the test window unfocused on Windows CI: Playwright’s close-time screenshot of a hidden window took 2.2–5 s inside the 10 s close deadline (BST-2239)', () => {
    expect(e2eShowInactive({ CI: 'true' }, 'win32')).toBe('1');
  });

  it('keeps the test window hidden off CI and on macOS, so runs never pop up on a desktop', () => {
    expect(e2eShowInactive({}, 'linux')).toBe('');
    expect(e2eShowInactive({}, 'win32')).toBe('');
    expect(e2eShowInactive({ CI: 'true' }, 'darwin')).toBe('');
  });

  it('lets an explicit value win either way', () => {
    expect(e2eShowInactive({ BRAINSTRIKE_E2E_SHOW_INACTIVE: '', CI: 'true' }, 'win32')).toBe('');
    expect(e2eShowInactive({ BRAINSTRIKE_E2E_SHOW_INACTIVE: '1' }, 'darwin')).toBe('1');
  });
});
