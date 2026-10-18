/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, createLogger, LogLevel, resetLogger } from '../logger.js';

// Bundlers resolve `pino` to its `browser` field; Vitest resolves the Node
// build, which ignores the browser `write` option entirely.
vi.mock('pino', async () => {
  const browserPino = await vi.importActual<{ default: typeof import('pino').default }>(
    'pino/browser.js'
  );
  return { default: browserPino.default };
});

// The real browser path: Pino's browser mode with redaction configured, written
// through the logger's own console formatter (BST-2154).
describe('browser console lines', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureLogger({
      console: { enabled: true },
      level: LogLevel.DEBUG,
      redactPaths: ['password'],
    });
  });

  afterEach(() => {
    resetLogger();
    consoleError.mockRestore();
  });

  function lastErrorLine(): string {
    const line = consoleError.mock.calls.at(-1)?.[0];
    if (typeof line !== 'string') {
      throw new Error('expected one formatted console.error line');
    }
    return line;
  }

  it('prints a structured record without redaction internals', () => {
    createLogger('Probe').error('Reading the saved theme failed', {
      attempt: 0,
      password: 'hunter2',
    });

    const line = lastErrorLine();
    expect(line).toBe(
      '[Probe] Reading the saved theme failed {"attempt":0,"password":"[Redacted]"}'
    );
    expect(line).not.toContain('restore');
  });

  it('keeps the context and the error of a (message, context, error) call', () => {
    createLogger('Probe').error('Tab panel crashed', { label: 'Changes' }, new Error('boom'));

    const line = lastErrorLine();
    expect(line).toContain('[Probe] Tab panel crashed {');
    expect(line).toContain('"label":"Changes"');
    expect(line).toContain('"message":"boom"');
    expect(line).not.toContain('restore');
  });
});
