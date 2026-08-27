import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMainLogTransportPath } from '../../diagnostics/main-log-transport-path';

describe('main log transport path', () => {
  it('resolves the built worker beside a directly launched main.js in development', () => {
    expect(
      resolveMainLogTransportPath(
        '/repo/apps/desktop/dist',
        false,
        '/repo/apps/desktop/dist/main.js'
      )
    ).toBe(path.join('/repo/apps/desktop', 'dist', 'main-log-transport.js'));
  });

  it('resolves the unpacked worker beside app.asar in a packaged application', () => {
    expect(
      resolveMainLogTransportPath(
        '/Applications/BrainStrike.app/Contents/Resources/app.asar',
        true,
        '/Applications/BrainStrike.app/Contents/Resources/app.asar/dist/main.js'
      )
    ).toBe(
      path.join(
        '/Applications/BrainStrike.app/Contents/Resources',
        'app.asar.unpacked',
        'dist',
        'main-log-transport.js'
      )
    );
  });

  it('rejects an unexpected packaged application layout', () => {
    expect(() =>
      resolveMainLogTransportPath(
        '/Applications/BrainStrike/resources/app',
        true,
        '/Applications/BrainStrike/resources/app/dist/main.js'
      )
    ).toThrow(/app\.asar/);
  });
});
