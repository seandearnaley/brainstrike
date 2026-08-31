import { describe, expect, it } from 'vitest';
import { readMainSourceSections } from './main-source-test-helpers';

describe('command session manager lifecycle wiring', () => {
  it('configures the manager and reaps it during shutdown and factory reset', () => {
    const { assistantShutdownBlock, source } = readMainSourceSections();

    expect(source).toContain(
      'configureDesktopCommandSessionManager({ resolver: createDatabaseRootResolver(getDatabase) });'
    );
    const assistantStep = assistantShutdownBlock.indexOf("runShutdownStep('assistant-server'");
    const settlement = assistantShutdownBlock.indexOf('Promise.allSettled([');
    const commandSessionReaper = assistantShutdownBlock.indexOf(
      'Promise.resolve().then(disposeDesktopCommandSessions)'
    );
    expect(assistantStep).toBeGreaterThanOrEqual(0);
    expect(settlement).toBeGreaterThan(assistantStep);
    expect(commandSessionReaper).toBeGreaterThan(settlement);
    expect(assistantShutdownBlock).toContain(
      "runShutdownStep('mcp-runtime', cleanupMcpRuntimeForShutdown)"
    );
    expect(source).toMatch(/name:\s*'command-sessions',\s*stop:\s*disposeDesktopCommandSessions/);
  });
});
