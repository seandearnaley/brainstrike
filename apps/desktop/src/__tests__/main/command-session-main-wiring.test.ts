import { describe, expect, it } from 'vitest';
import { readMainSourceSections } from './main-source-test-helpers';

describe('command session manager lifecycle wiring', () => {
  it('configures the manager and reaps it during shutdown and factory reset', () => {
    const { source, stepBody } = readMainSourceSections();

    expect(source).toContain(
      'configureDesktopCommandSessionManager({ resolver: createDatabaseRootResolver(getDatabase) });'
    );
    const assistantStep = stepBody('assistant-server');
    const settlement = assistantStep.indexOf('Promise.allSettled([');
    const commandSessionReaper = assistantStep.indexOf(
      'Promise.resolve().then(disposeDesktopCommandSessions)'
    );
    expect(settlement).toBeGreaterThan(0);
    expect(commandSessionReaper).toBeGreaterThan(settlement);
    expect(stepBody('mcp-runtime')).toContain('() => cleanupMcpRuntimeForShutdown()');
    expect(source).toMatch(/name:\s*'command-sessions',\s*stop:\s*disposeDesktopCommandSessions/);
  });
});
