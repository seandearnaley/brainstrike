import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('command session manager lifecycle wiring', () => {
  it('configures the manager and reaps it during shutdown and factory reset', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

    expect(source).toContain(
      'configureDesktopCommandSessionManager({ resolver: createDatabaseRootResolver(getDatabase) });'
    );
    expect(source).toMatch(
      /runShutdownStep\('assistant-server',[\s\S]*await disposeDesktopCommandSessions\(\)/
    );
    expect(source).toMatch(/name:\s*'command-sessions',\s*stop:\s*disposeDesktopCommandSessions/);
  });
});
