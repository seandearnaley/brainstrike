// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';

const owners = vi.hoisted(() => ({
  commands: vi.fn<() => Promise<number>>(),
  languageServers: vi.fn<() => Promise<void>>(),
  sessions: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../src/native-tools/execute-command-tool.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/native-tools/execute-command-tool.ts')>()),
  disposeLiveChildProcesses: owners.commands,
}));
vi.mock('../../src/native-tools/lsp-diagnostics.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/native-tools/lsp-diagnostics.ts')>()),
  disposeLspServers: owners.languageServers,
}));
vi.mock('../../src/command-sessions/command-session-manager.ts', () => ({
  createCommandSessionManager: () => ({ dispose: owners.sessions }),
}));

beforeEach(() => {
  vi.resetModules();
  owners.commands.mockReset().mockResolvedValue(0);
  owners.languageServers.mockReset().mockResolvedValue(undefined);
  owners.sessions.mockReset().mockResolvedValue(undefined);
});

test('host tool disposal joins physical command retirement before it acknowledges completion', async () => {
  const joined = Promise.withResolvers<number>();
  owners.commands.mockReturnValue(joined.promise);
  const { disposeHostTools, hostCommandSessionManager } = await import(
    '../../src/command-sessions/host-tool-process.ts'
  );
  hostCommandSessionManager();
  let completed = false;
  const disposal = disposeHostTools().then(() => {
    completed = true;
  });

  await vi.waitFor(() => expect(owners.commands).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(owners.sessions).toHaveBeenCalledTimes(1);
  joined.resolve(1);
  await disposal;
  expect(completed).toBe(true);
});

test('independent LSP and session failures do not skip the command join or lose error identity', async () => {
  const lspFailure = new Error('Language server retirement failed');
  const sessionFailure = new Error('Session retirement failed');
  const commandFailure = new Error('Native command Job cleanup was denied');
  const joined = Promise.withResolvers<number>();
  owners.languageServers.mockRejectedValue(lspFailure);
  owners.sessions.mockRejectedValue(sessionFailure);
  owners.commands.mockReturnValue(joined.promise);
  const { disposeHostTools, hostCommandSessionManager } = await import(
    '../../src/command-sessions/host-tool-process.ts'
  );
  hostCommandSessionManager();
  let completed = false;
  const disposal = disposeHostTools().catch((error: unknown) => {
    completed = true;
    return error;
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(owners.commands).toHaveBeenCalledTimes(1);
  expect(owners.sessions).toHaveBeenCalledTimes(1);
  expect(completed).toBe(false);
  joined.reject(commandFailure);
  const failure = await disposal;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([lspFailure, commandFailure, sessionFailure]);
});
